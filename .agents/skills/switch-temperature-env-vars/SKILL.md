# Switch temperature env vars

This project picks the active AI provider and model from environment variables only.
To change the provider or model, set the matching environment variables before the server starts;
do not edit server config files, hardcoded fallbacks, or UI state to make this change.

## What to change

1. Identify the environment variable names the project already uses for provider selection.
   Look for them in docs, existing run scripts, `.env` templates, and server startup code.

2. Set only those variables for the current run:
   - Provider identifier variable
   - Model name variable
   - Any base URL, API key, or runtime flag variable the provider requires

3. Restart the process so the new values take effect before any request is made.

## Rule

If a variable is not already part of the project's documented runtime configuration,
do not invent a new one. Use the existing convention, or ask before adding one.

## Verification

After restarting, confirm the active provider and model reflect the new environment variables
through the project's normal status output or health endpoint, not by guessing.
