<!--
title: 'AWS NodeJS Example'
description: 'This template demonstrates how to deploy a simple NodeJS function running on AWS Lambda using the Serverless Framework.'
layout: Doc
framework: v4
platform: AWS
language: nodeJS
priority: 1
authorLink: 'https://github.com/serverless'
authorName: 'Serverless, Inc.'
authorAvatar: 'https://avatars1.githubusercontent.com/u/13742415?s=200&v=4'
-->

# gravesham-bin-days

Daily Lambda that checks Gravesham "Check your bin day" and sends email notifications if there is a collection tomorrow. Runs at 12:00 Europe/London. Uses Puppeteer + @sparticuz/chromium.

## Config

Edit `config/recipients.json` and redeploy.

Plain string recipients are sent directly with the Gmail API. Add `{ "type": "buttondown" }` to publish the notification through Buttondown instead. You can include both for the same address while testing.

Structured recipients can set `hideLabelInSubject` to remove the exact lookup address from the subject for that delivery target. This is useful when one exact address is used to look up the schedule for a wider street mailing list.

```
{
  "timezone": "Europe/London",
  "notify": {
    "atLocalTime": "12:00",
    "daysLookahead": 1,
    "messageSuffix": "Put bins out after 7pm tonight."
  },
  "addresses": [
    {
      "label": "10 Example Road, DA12 1AA",
      "recipients": [
        "you@example.com",
        {
          "type": "buttondown",
          "hideLabelInSubject": true
        }
      ]
    }
  ]
}
```

## Buttondown

Store the Buttondown API key in Parameter Store:

```
aws ssm put-parameter \
  --name "/gravesham-bin-days/buttondown-api-key" \
  --value "your-buttondown-api-key" \
  --type "SecureString" \
  --overwrite \
  --region eu-west-2
```

For local development, you can set `BUTTONDOWN_API_KEY`. Buttondown uses `about_to_send` by default for immediate delivery; set `BUTTONDOWN_EMAIL_STATUS=draft` if you want API-created emails to remain drafts.

## Deploy

```
sls deploy
```

## Retry behavior and manual runs

Each address lookup waits up to 15 seconds for a visible address field, then
retries failed scrapes in fresh browser tabs up to three total attempts, with
2-second and 4-second delays. Each attempt has a 60-second budget. The Lambda
timeout is 5 minutes; retries shorten their budget or stop early when necessary
to leave 20 seconds for notification delivery and cleanup.

Other addresses are still processed after an exhausted lookup. The handler then
throws an error instead of reporting success, allowing Lambda to retry a failed
scheduled invocation twice. Asynchronous events expire after one hour. Addresses
already marked as notified for tomorrow are skipped before scraping on subsequent
runs. Notification delivery itself is not retried by the scrape retry loop.

Deploy both the handler and timeout/retry configuration with `sls deploy`.
To manually invoke the deployed job and see its logs:

```sh
sls invoke --function daily --region eu-west-2 --data '{}' --log
```

Add `--stage <stage>` if needed. A manual synchronous invocation reports errors
directly; Lambda's asynchronous retries apply to the scheduled invocation.
The job checks tomorrow relative to the current time, so rerun a missed check
before midnight. Avoid `forceNotify` for routine recovery: it bypasses notification
deduplication and can send notifications for the next collection even when none is
tomorrow.

Run the offline regression tests with `npm test`.
