// Unit tests run server code in the test process: an error it logs must not reach a webhook set in a local .env.
delete process.env.DISCORD_ALARM_WEBHOOK;
