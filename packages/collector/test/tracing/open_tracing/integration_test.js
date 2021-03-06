'use strict';

const expect = require('chai').expect;

const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../core/test/config');
const testUtils = require('../../../../core/test/test_util');

describe('tracing/opentracing/integration', function() {
  const agentStubControls = require('../../apps/agentStubControls');
  const expressOpentracingControls = require('./controls');

  this.timeout(config.getTestTimeout());

  agentStubControls.registerTestHooks();

  describe('with automatic tracing', () => {
    expressOpentracingControls.registerTestHooks();

    beforeEach(() => agentStubControls.waitUntilAppIsCompletelyInitialized(expressOpentracingControls.getPid()));

    it('must not generate opentracing traces when OT is not used', () =>
      expressOpentracingControls.sendRequest({ path: '/' }).then(() =>
        testUtils.retry(() =>
          agentStubControls.getSpans().then(spans => {
            if (supportedVersion(process.versions.node)) {
              expect(spans).to.have.lengthOf(1);
              expect(spans[0].n).to.equal('node.http.server');
            } else {
              expect(spans).to.have.lengthOf(0);
            }
          })
        )
      ));

    it('must generate opentracing traces', () =>
      expressOpentracingControls.sendRequest({ path: '/withOpentracing' }).then(() =>
        testUtils.retry(() =>
          agentStubControls.getSpans().then(spans => {
            const serviceSpan = testUtils.expectAtLeastOneMatching(spans, span => {
              expect(span.t).to.be.a('string');
              expect(span.s).to.be.a('string');
              expect(span.s).to.equal(span.t);
              expect(span.p).to.equal(undefined);
              expect(span.n).to.equal('sdk');
              expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
              expect(span.f.h).to.equal('agent-stub-uuid');
              expect(span.data.service).to.equal('theFancyServiceYouWouldntBelieveActuallyExists');
              expect(span.data.sdk.name).to.equal('service');
              expect(span.data.sdk.type).to.equal('entry');
            });

            testUtils.expectAtLeastOneMatching(spans, span => {
              expect(span.t).to.equal(serviceSpan.t);
              expect(span.p).to.equal(serviceSpan.s);
              expect(span.s).to.be.a('string');
              expect(span.s).not.to.equal(span.t);
              expect(span.s).not.to.equal(span.p);
              expect(span.n).to.equal('sdk');
              expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
              expect(span.f.h).to.equal('agent-stub-uuid');
              expect(span.data.service).to.equal('theFancyServiceYouWouldntBelieveActuallyExists');
              expect(span.data.sdk.name).to.equal('auth');
              expect(span.data.sdk.type).to.equal('local');
            });

            if (supportedVersion(process.versions.node)) {
              expect(spans).to.have.lengthOf(3);
            } else {
              expect(spans).to.have.lengthOf(2);
            }
          })
        )
      ));

    if (supportedVersion(process.versions.node)) {
      it('must connect instana trace to opentracing spans', () =>
        expressOpentracingControls.sendRequest({ path: '/withOpentracingConnectedToInstanaTrace' }).then(() =>
          testUtils.retry(() =>
            agentStubControls.getSpans().then(spans => {
              expect(spans).to.have.lengthOf(2);

              const httpSpan = testUtils.expectAtLeastOneMatching(spans, span => {
                expect(span.n).to.equal('node.http.server');
                expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
                expect(span.f.h).to.equal('agent-stub-uuid');
              });

              testUtils.expectAtLeastOneMatching(spans, span => {
                expect(span.t).to.equal(httpSpan.t);
                expect(span.p).to.equal(httpSpan.s);
                expect(span.s).to.be.a('string');
                expect(span.s).not.to.equal(span.t);
                expect(span.s).not.to.equal(span.p);
                expect(span.n).to.equal('sdk');
                expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
                expect(span.f.h).to.equal('agent-stub-uuid');
                expect(span.data.service).to.equal('theFancyServiceYouWouldntBelieveActuallyExists');
                expect(span.data.sdk.name).to.equal('service');
              });
            })
          )
        ));

      it('must contain baggage in instana span context', () =>
        expressOpentracingControls.sendRequest({ path: '/getCurrentlyActiveInstanaSpanContext' }).then(body => {
          expect(JSON.parse(body).baggage).to.deep.equal({});
        }));
    }
  });

  describe('without automatic tracing', () => {
    expressOpentracingControls.registerTestHooks({ disableAutomaticTracing: true });

    beforeEach(() => agentStubControls.waitUntilAppIsCompletelyInitialized(expressOpentracingControls.getPid()));

    it('must only generate opentracing traces', () =>
      expressOpentracingControls.sendRequest({ path: '/withOpentracing' }).then(() =>
        testUtils.retry(() =>
          agentStubControls.getSpans().then(spans => {
            const serviceSpan = testUtils.expectAtLeastOneMatching(spans, span => {
              expect(span.t).to.be.a('string');
              expect(span.s).to.be.a('string');
              expect(span.s).to.equal(span.t);
              expect(span.p).to.equal(undefined);
              expect(span.n).to.equal('sdk');
              expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
              expect(span.f.h).to.equal('agent-stub-uuid');
              expect(span.data.service).to.equal('theFancyServiceYouWouldntBelieveActuallyExists');
              expect(span.data.sdk.name).to.equal('service');
              expect(span.data.sdk.type).to.equal('entry');
            });

            testUtils.expectAtLeastOneMatching(spans, span => {
              expect(span.t).to.equal(serviceSpan.t);
              expect(span.p).to.equal(serviceSpan.s);
              expect(span.s).to.be.a('string');
              expect(span.s).not.to.equal(span.t);
              expect(span.s).not.to.equal(span.p);
              expect(span.n).to.equal('sdk');
              expect(span.f.e).to.equal(String(expressOpentracingControls.getPid()));
              expect(span.f.h).to.equal('agent-stub-uuid');
              expect(span.data.service).to.equal('theFancyServiceYouWouldntBelieveActuallyExists');
              expect(span.data.sdk.name).to.equal('auth');
              expect(span.data.sdk.type).to.equal('local');
            });

            expect(spans).to.have.lengthOf(2);
          })
        )
      ));
  });
});
