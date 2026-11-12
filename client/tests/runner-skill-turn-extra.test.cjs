'use strict';
const catalog = require('../main/agent-runtime/runtime-catalog');
const { registerSkillTurns } = require('./runner-skill-turn-fixture.cjs');
registerSkillTurns(catalog.runnerRuntimes().filter((_spec, index) => index % 3 === 1));
