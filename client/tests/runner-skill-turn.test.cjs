'use strict';
// Keep every runtime contract while staying within the unchanged file deadline.
// Native process teardown costs accumulate across otherwise bounded cases.
const catalog = require('../main/agent-runtime/runtime-catalog');
const { registerSkillTurns, registerSkillStop } = require('./runner-skill-turn-fixture.cjs');
registerSkillTurns(catalog.runnerRuntimes().filter((_spec, index) => index % 3 === 0));
registerSkillStop();
