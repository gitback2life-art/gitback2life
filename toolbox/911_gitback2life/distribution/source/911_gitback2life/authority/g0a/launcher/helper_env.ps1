# G0a prototype helper: prints the NAMES (never values) of the environment variables it received.
# Uses only language features and .NET types; loads no modules.
foreach ($k in [System.Environment]::GetEnvironmentVariables().Keys) { [Console]::Out.WriteLine([string]$k) }
