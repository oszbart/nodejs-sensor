/* eslint-disable no-console */

'use strict';

/**
 * This little tool exists to send some made-up infra monitoring data about a Lambda to an acceptor.
 */

/* CONFIGURATION */
const acceptorHost = 'localhost';
const acceptorPort = 8989;
const acceptorTimeout = 5000;
const sendUnencrypted = true;
const acceptSelfSignedCert = false;

const legacySensorMode = process.env.LEGACY_SENSOR != null;
const anotherLambda = process.env.ANOTHER != null;

const name = anotherLambda ? 'wrapped_callback_8_10' : 'wrapped_async_8_10';
const unqualifiedArn = anotherLambda
  ? `arn:aws:lambda:us-east-2:521808193417:function:${name}`
  : `arn:aws:lambda:us-east-2:410797082306:function:${name}`;

const https = sendUnencrypted ? require('http') : require('https');
const constants = require('../../src/util/constants');

const instanaKeyEnvVar = 'INSTANA_KEY';
const instanaKey = process.env[instanaKeyEnvVar];

if (instanaKey == null) {
  console.error('An agent key needs to be provided via INSTANA_KEY.');
  process.exit(1);
}

function random(maxValue) {
  return Math.floor(Math.random() * (maxValue + 1));
}

function sendPayload(callback) {
  let version = '$LATEST';
  if (!legacySensorMode && random(5) > 3) {
    // send data about other versions (versions 1, 2, 3) sometimes (at randoml)
    version = (1 + random(4)).toString();
  }
  const qualifiedArn = `${unqualifiedArn}:${version}`;

  const metricsData = {
    aws_grouping_zone: 'us-east-2',
    name,
    arn: legacySensorMode ? unqualifiedArn : qualifiedArn,
    version: legacySensorMode ? undefined : version,
    runtime: 'nodejs8.10',
    handler: 'index.handler',
    timeout: 3,
    memory_size: 128,
    last_modified: '2019-08-28T07:24:32.123+0000',
    iterator_age_maximum: 0,
    duration_sum: 0,
    errors: random(5),
    unreserved_concurrent_executions: random(3),
    duration: random(1000),
    throttles: 0,
    iterator_age: random(10),
    concurrent_executions_sum: random(5),
    iterator_age_minimum: 0,
    duration_minimum: 0,
    dead_letter_error: 0,
    invocations: random(100),
    iterator_age_sum: 0,
    duration_maximum: 0,
    tags: {
      much: 'wow',
      very: 'tagged'
    }
  };

  console.log(`sending: ${JSON.stringify(metricsData, null, 2)}`);

  const metricsPayload = {
    plugins: [{ name: 'com.instana.plugin.aws.lambda', entityId: qualifiedArn, data: metricsData }]
  };

  const payload = JSON.stringify(metricsPayload);

  const options = {
    hostname: acceptorHost,
    port: acceptorPort,
    path: '/metrics',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      [constants.xInstanaHost]: unqualifiedArn,
      [constants.xInstanaKey]: instanaKey,
      [constants.xInstanaTime]: Date.now()
    },
    rejectUnauthorized: !acceptSelfSignedCert
  };

  const req = https.request(options, res => {
    const unexpectedStatus = res.statusCode < 200 || res.statusCode >= 300;
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      // Ignore response data unless we received an HTTP status code indicating a problem.
      if (unexpectedStatus) {
        data += chunk;
      }
    });
    res.on('end', () => {
      if (unexpectedStatus) {
        return callback(
          new Error(
            `Received an unexpected HTTP status (${res.statusCode}) from the Instana back end. Message: ${data}`
          )
        );
      }
      return callback();
    });
  });
  req.setTimeout(acceptorTimeout, () => {
    callback(new Error(`The Instana back end did not respond in the configured timeout of ${acceptorTimeout} ms.`));
  });

  req.on('error', e => {
    callback(e);
  });

  req.write(payload);
  req.end();
}

sendPayload(e => {
  if (e) {
    console.error('Failed 😭', e);
    process.exit(1);
  } else {
    console.log('Done 🎉');
    process.exit(0);
  }
});
