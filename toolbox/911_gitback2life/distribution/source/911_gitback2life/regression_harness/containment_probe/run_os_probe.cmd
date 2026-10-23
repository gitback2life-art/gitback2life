@echo off
rem OS egress probe launcher (V4-06): for use INSIDE the tests-mode Windows Sandbox only (the probe refuses elsewhere).
rem Runs node DIRECTLY: no run_offline, no Node network guard, no proxy variables. Nothing contacts a real host.
cd /d C:\gb2l || (echo Not inside the gitback2life sandbox: C:\gb2l does not exist. Nothing was run. & exit /b 1)
set NODE_OPTIONS=
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
node regression_harness\containment_probe\os_egress_probe.mjs
