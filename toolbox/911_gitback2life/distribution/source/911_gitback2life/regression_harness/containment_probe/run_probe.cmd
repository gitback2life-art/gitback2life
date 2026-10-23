@echo off
rem Containment probe launcher: for use INSIDE the tests-mode Windows Sandbox only (run_offline refuses anywhere else).
rem Typing this file's name is the person's confirmation that they read package.json and probe.test.mjs (--reviewed).
cd /d C:\gb2l || (echo Not inside the gitback2life sandbox: C:\gb2l does not exist. Nothing was run. & exit /b 1)
node regression_harness\run_offline.mjs --cwd regression_harness\containment_probe --reviewed --scope regression_harness\containment_probe\probe.scope.json -- npm test
