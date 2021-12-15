/* eslint-disable no-console */

import { Worker } from 'worker_threads';

import asyncQueue from 'neo-async/queue';

import WorkerError from './WorkerError';

const workerPath = require.resolve('./worker');

let workerId = 0;

class PoolWorker {
  constructor(options, onJobDone) {
    this.disposed = false;
    this.nextJobId = 0;
    this.jobs = Object.create(null);
    this.activeJobs = 0;
    this.onJobDone = onJobDone;
    this.id = workerId;

    workerId += 1;

    this.worker = new Worker(workerPath);
    this.worker.unref();
    this.worker.on('message', this.onWorkerMessage.bind(this));
  }

  listenStdOutAndErrFromWorker(workerStdout, workerStderr) {
    if (workerStdout) {
      workerStdout.on('data', this.writeToStdout);
    }

    if (workerStderr) {
      workerStderr.on('data', this.writeToStderr);
    }
  }

  writeToStdout(data) {
    if (!this.disposed) {
      process.stdout.write(data);
    }
  }

  writeToStderr(data) {
    if (!this.disposed) {
      process.stderr.write(data);
    }
  }

  run(data, callback) {
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    this.jobs[jobId] = { data, callback };
    this.activeJobs += 1;
    const dateToPost = {
      loaders: data.loaders,
      resource: data.resource,
      sourceMap: data.sourceMap,
      target: data.target,
      minimize: data.minimize,
      resourceQuery: data.resourceQuery,
      optionsContext: data.optionsContext,
      rootContext: data.rootContext,
    };
    this.writeJson({
      type: 'job',
      id: jobId,
      data: dateToPost,
    });
  }

  warmup(requires) {
    this.writeJson({
      type: 'warmup',
      requires,
    });
  }

  writeJson(data) {
    this.worker.postMessage(data);
  }

  onWorkerMessage(message) {
    const { type, id } = message;
    switch (type) {
      case 'job': {
        const { error, result } = message;
        const { callback: jobCallback } = this.jobs[id];
        const callback = (err, arg) => {
          if (jobCallback) {
            delete this.jobs[id];
            this.activeJobs -= 1;
            this.onJobDone();
            if (err) {
              jobCallback(err instanceof Error ? err : new Error(err), arg);
            } else {
              jobCallback(null, arg);
            }
          }
        };
        if (error) {
          callback(this.fromErrorObj(error), result);
          return;
        }
        callback(null, result);
        break;
      }
      case 'loadModule': {
        const { request, questionId } = message;
        const { data } = this.jobs[id];
        // eslint-disable-next-line no-unused-vars
        data.loadModule(request, (error, source, sourceMap, module) => {
          this.writeJson({
            type: 'result',
            id: questionId,
            error: error
              ? {
                  message: error.message,
                  details: error.details,
                  missing: error.missing,
                }
              : null,
            result: [
              source,
              sourceMap,
              // TODO: Serialize module?
              // module,
            ],
          });
        });
        break;
      }
      case 'resolve': {
        const { context, request, options, questionId } = message;
        const { data } = this.jobs[id];
        if (options) {
          data.getResolve(options)(context, request, (error, result) => {
            this.writeJson({
              type: 'result',
              id: questionId,
              error: error
                ? {
                    message: error.message,
                    details: error.details,
                    missing: error.missing,
                  }
                : null,
              result,
            });
          });
        } else {
          data.resolve(context, request, (error, result) => {
            this.writeJson({
              type: 'result',
              id: questionId,
              error: error
                ? {
                    message: error.message,
                    details: error.details,
                    missing: error.missing,
                  }
                : null,
              result,
            });
          });
        }
        break;
      }
      case 'emitWarning': {
        const { data } = message;
        const { data: jobData } = this.jobs[id];
        jobData.emitWarning(this.fromErrorObj(data));
        break;
      }
      case 'emitError': {
        const { data } = message;
        const { data: jobData } = this.jobs[id];
        jobData.emitError(this.fromErrorObj(data));
        break;
      }
      default: {
        console.error(`Unexpected worker message ${type} in WorkerPool.`);
        break;
      }
    }
  }

  fromErrorObj(arg) {
    let obj;
    if (typeof arg === 'string') {
      obj = { message: arg };
    } else {
      obj = arg;
    }
    return new WorkerError(obj, this.id);
  }

  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.worker.terminate();
    }
  }
}

export default class WorkerPool {
  constructor(options) {
    this.options = options || {};
    this.numberOfWorkers = options.numberOfWorkers;
    this.poolTimeout = options.poolTimeout;
    this.workerNodeArgs = options.workerNodeArgs;
    this.workerParallelJobs = options.workerParallelJobs;
    this.workers = new Set();
    this.activeJobs = 0;
    this.timeout = null;
    this.poolQueue = asyncQueue(
      this.distributeJob.bind(this),
      options.poolParallelJobs
    );
    this.terminated = false;

    this.setupLifeCycle();
  }

  isAbleToRun() {
    return !this.terminated;
  }

  terminate() {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.poolQueue.kill();
    this.disposeWorkers(true);
  }

  setupLifeCycle() {
    process.on('exit', () => {
      this.terminate();
    });
  }

  run(data, callback) {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.activeJobs += 1;
    this.poolQueue.push(data, callback);
  }

  distributeJob(data, callback) {
    // use worker with the fewest jobs
    let bestWorker;
    for (const worker of this.workers) {
      if (!bestWorker || worker.activeJobs < bestWorker.activeJobs) {
        bestWorker = worker;
      }
    }
    if (
      bestWorker &&
      (bestWorker.activeJobs === 0 || this.workers.size >= this.numberOfWorkers)
    ) {
      bestWorker.run(data, callback);
      return;
    }
    const newWorker = this.createWorker();
    newWorker.run(data, callback);
  }

  createWorker() {
    // spin up a new worker
    const newWorker = new PoolWorker(
      {
        nodeArgs: this.workerNodeArgs,
        parallelJobs: this.workerParallelJobs,
      },
      () => this.onJobDone()
    );
    this.workers.add(newWorker);
    return newWorker;
  }

  warmup(requires) {
    while (this.workers.size < this.numberOfWorkers) {
      this.createWorker().warmup(requires);
    }
  }

  onJobDone() {
    this.activeJobs -= 1;
    if (this.activeJobs === 0 && isFinite(this.poolTimeout)) {
      this.timeout = setTimeout(() => this.disposeWorkers(), this.poolTimeout);
    }
  }

  disposeWorkers(fromTerminate) {
    if (!this.options.poolRespawn && !fromTerminate) {
      this.terminate();
      return;
    }

    if (this.activeJobs === 0 || fromTerminate) {
      for (const worker of this.workers) {
        worker.dispose();
      }
      this.workers.clear();
    }
  }
}
