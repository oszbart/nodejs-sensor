'use strict';

var shimmer = require('shimmer');

var requireHook = require('../../../util/requireHook');
var tracingUtil = require('../../tracingUtil');
var constants = require('../../constants');
var cls = require('../../cls');

var isActive = false;

var commands = [
  //
  'count',
  'delete',
  'distinct',
  'find',
  'findAndModify',
  'findandmodify',
  'getMore',
  'getmore',
  'insert',
  'update'
];

exports.init = function() {
  // mongodb >= 3.3.x
  requireHook.onFileLoad(/\/mongodb\/lib\/core\/connection\/pool.js/, instrumentPool);
  // mongodb < 3.3.x
  requireHook.onFileLoad(/\/mongodb-core\/lib\/connection\/pool.js/, instrumentPool);
};

function instrumentPool(Pool) {
  shimmer.wrap(Pool.prototype, 'write', shimWrite);
}

function shimWrite(original) {
  return function() {
    if (!isActive || !cls.isTracing()) {
      return original.apply(this, arguments);
    }
    var originalArgs = new Array(arguments.length);
    for (var i = 0; i < arguments.length; i++) {
      originalArgs[i] = arguments[i];
    }
    return instrumentedWrite(this, original, originalArgs);
  };
}

function instrumentedWrite(ctx, originalWrite, originalArgs) {
  var parentSpan = cls.getCurrentSpan();
  if (constants.isExitSpan(parentSpan)) {
    return originalWrite.apply(ctx, originalArgs);
  }

  // pool.js#write throws a sync error if there is no callback, so we can safely assume there is one. If there was no
  // callback, we wouldn't be able to finish the span, so we won't start one.
  var originalCallback;
  var callbackIndex = -1;
  for (var i = 1; i < originalArgs.length; i++) {
    if (typeof originalArgs[i] === 'function') {
      originalCallback = originalArgs[i];
      callbackIndex = i;
      break;
    }
  }
  if (callbackIndex < 0) {
    return originalWrite.apply(ctx, originalArgs);
  }

  return cls.ns.runAndReturn(function() {
    var span = cls.startSpan('mongo', constants.EXIT);
    span.stack = tracingUtil.getStackTrace(instrumentedWrite);

    var hostname;
    var port;
    var service;
    var command;
    var database;
    var collection;
    var namespace;

    var message = originalArgs[0];
    if (message && typeof message === 'object') {
      if (
        message.options &&
        message.options.session &&
        message.options.session.topology &&
        message.options.session.topology.s &&
        message.options.session.topology.s
      ) {
        hostname = message.options.session.topology.s.host;
        port = message.options.session.topology.s.port;
      }

      if ((!hostname || !port) && ctx.options) {
        // fallback for older versions of mongodb package
        if (!hostname) {
          hostname = ctx.options.host;
        }
        if (!port) {
          port = ctx.options.port;
        }
      }

      var cmdObj = message.command;
      if (!cmdObj) {
        // fallback for older mongodb versions
        cmdObj = message.query;
      }
      if (cmdObj) {
        if (cmdObj.collection) {
          // only getMore commands have the collection attribute
          collection = cmdObj.collection;
        }
        if (!collection) {
          collection = findCollection(cmdObj);
        }
        command = findCommand(cmdObj);
        database = cmdObj.$db;
      }

      if (!database && typeof message.ns === 'string') {
        // fallback for older mongodb versions
        database = message.ns.split('.')[0];
      }
    }

    if (database && collection) {
      namespace = database + '.' + collection;
    } else if (database) {
      namespace = database + '.?';
    } else if (collection) {
      namespace = '?.' + collection;
    }

    if (hostname || port) {
      span.data.peer = {
        hostname: hostname,
        port: port
      };
    }

    if (hostname && port) {
      service = hostname + ':' + port;
    } else if (hostname) {
      service = hostname + ':27017';
    } else if (port) {
      service = '?:27017';
    }

    span.data.mongo = {
      command: command,
      service: service,
      namespace: namespace
    };
    readJsonOrFilter(message, span);

    var wrappedCallback = function(error) {
      if (error) {
        span.ec = 1;
        span.data.mongo.error = tracingUtil.getErrorDetails(error);
      }

      span.d = Date.now() - span.ts;
      span.transmit();

      return originalCallback.apply(this, arguments);
    };
    originalArgs[callbackIndex] = cls.ns.bind(wrappedCallback);

    return originalWrite.apply(ctx, originalArgs);
  });
}

function findCollection(cmdObj) {
  for (var j = 0; j < commands.length; j++) {
    if (cmdObj[commands[j]] && typeof cmdObj[commands[j]] === 'string') {
      // most commands (except for getMore) add the collection as the value for the command-specific key
      return cmdObj[commands[j]];
    }
  }
}

function findCommand(cmdObj) {
  for (var j = 0; j < commands.length; j++) {
    if (cmdObj[commands[j]]) {
      return commands[j];
    }
  }
}

function readJsonOrFilter(message, span) {
  if (!message) {
    return;
  }
  var cmdObj = message.command;
  if (!cmdObj) {
    cmdObj = message.query;
  }
  if (!cmdObj) {
    return;
  }
  var json;
  var filter = cmdObj.filter || cmdObj.query;

  if (Array.isArray(cmdObj.updates) && cmdObj.updates.length >= 1) {
    json = cmdObj.updates;
  } else if (Array.isArray(cmdObj.deletes) && cmdObj.deletes.length >= 1) {
    json = cmdObj.deletes;
  }

  // The back end will process exactly one of json, query, or filter, so it does not matter too much which one we
  // provide.
  if (json) {
    span.data.mongo.json = stringifyWhenNecessary(json);
  } else if (filter) {
    span.data.mongo.filter = stringifyWhenNecessary(filter);
  }
}

function stringifyWhenNecessary(obj) {
  if (obj == null) {
    return undefined;
  } else if (typeof obj === 'string') {
    return tracingUtil.shortenDatabaseStatement(obj);
  }
  return tracingUtil.shortenDatabaseStatement(JSON.stringify(obj));
}

exports.activate = function() {
  isActive = true;
};

exports.deactivate = function() {
  isActive = false;
};
