'use strict';

var logger = require('@instana/core').logger.getLogger('metrics');
exports.setLogger = function(_logger) {
  logger = _logger;
};

var eventLoopStats;
try {
  eventLoopStats = require('event-loop-stats');
} catch (e) {
  logger.info(
    'Could not load event-loop-stats. You will only see limited event loop information in ' +
      'Instana for this application. This typically occurs when native addons could not be ' +
      'installed during module installation (npm install). See the instructions to learn more ' +
      'about the requirements of the collector: ' +
      'https://www.instana.com/docs/ecosystem/node-js/installation/#native-addons'
  );
}
var lag = require('event-loop-lag')(1000);

exports.payloadPrefix = 'libuv';
exports.currentPayload = {};

Object.defineProperty(exports, 'currentPayload', {
  get: function() {
    var stats = sense();
    stats.lag = Math.round(lag() * 100) / 100;
    return stats;
  }
});

function sense() {
  if (eventLoopStats) {
    var stats = eventLoopStats.sense();
    stats.statsSupported = true;
    return stats;
  }
  return {
    statsSupported: false
  };
}
