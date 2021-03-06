'use strict';

const expect = require('chai').expect;
const path = require('path');
const semver = require('semver');

const constants = require('@instana/core').tracing.constants;
const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../../core/test/config');
const testUtils = require('../../../../../core/test/test_util');
const ProcessControls = require('../../../test_util/ProcessControls');

let agentControls;

describe('tracing/restore context', function() {
  if (!supportedVersion(process.versions.node)) {
    return;
  }

  agentControls = require('../../../apps/agentStubControls');

  this.timeout(config.getTestTimeout());

  agentControls.registerTestHooks();

  [
    //
    'sharp-app',
    'custom-queueing-app'
  ].forEach(appName => {
    [
      //
      'run',
      'run-promise',
      'enter-and-leave'
    ].forEach(apiVariant => {
      if (appName === 'sharp-app' && semver.gte(process.versions.node, '12.0.0')) {
        // The version of sharp we are using is not compatible with Node.js >= 12.x
        return;
      }
      registerSuite(appName, apiVariant);
    });
  });

  function registerSuite(appName, apiVariant) {
    describe(`restore context (${appName})`, function() {
      const controls = new ProcessControls({
        appPath: path.join(__dirname, appName),
        agentControls,
        port: 3222
      }).registerTestHooks();

      it(//
      `must capture spans after async context loss when context is manually restored ${appName}/${apiVariant})`, () => {
        let url = `/${apiVariant}`;
        return controls
          .sendRequest({
            method: 'POST',
            path: url
          })
          .then(() => verify(url));
      });
    });
  }
});

function verify(url) {
  return testUtils.retry(() =>
    agentControls.getSpans().then(spans => {
      const httpEntry = testUtils.expectAtLeastOneMatching(spans, span => {
        expect(span.n).to.equal('node.http.server');
        expect(span.k).to.equal(constants.ENTRY);
        expect(span.p).to.not.exist;
        expect(span.data.http.method).to.equal('POST');
        expect(span.data.http.url).to.equal(url);
      });

      testUtils.expectAtLeastOneMatching(spans, span => {
        expect(span.n).to.equal('log.pino');
        expect(span.k).to.equal(constants.EXIT);
        expect(span.p).to.equal(httpEntry.s);
        expect(span.data.log.message).to.equal('Should be traced.');
      });
    })
  );
}
