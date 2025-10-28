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

Daily Lambda that checks Gravesham "Check your bin day" and sends SMS if there is a collection tomorrow. Runs at 12:00 Europe/London. Uses Puppeteer + @sparticuz/chromium.

## Config

Edit `config/recipients.json` and redeploy.

```
{
  "timezone": "Europe/London",
  "notify": {
    "atLocalTime": "12:00",
    "daysLookahead": 1,
    "messageSuffix": "Put bins out after 7pm tonight."
  },
  "addresses": [
    { "label": "10 Example Road, DA12 1AA", "recipients": ["+447700900001"] }
  ]
}
```

## Deploy

```
sls deploy
```
