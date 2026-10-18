const fs = require('node:fs');
const { SSMClient, PutParameterCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DEFAULT_CONFIG_PARAMETER, parseRecipientsConfig } = require('../recipients-config');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run config:upload -- /absolute/path/to/recipients.json');
  const value = fs.readFileSync(file, 'utf8');
  parseRecipientsConfig(value);
  if (Buffer.byteLength(value, 'utf8') > 4096) {
    throw new Error('Recipient configuration exceeds the standard SSM parameter limit of 4096 bytes');
  }
  const client = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-2' });
  const name = process.env.RECIPIENTS_CONFIG_PARAMETER || DEFAULT_CONFIG_PARAMETER;
  const result = await client.send(new PutParameterCommand({
    Name: name, Value: value, Type: 'SecureString', Tier: 'Standard', Overwrite: true
  }));
  const saved = await client.send(new GetParameterCommand({
    Name: `${name}:${result.Version}`, WithDecryption: true
  }));
  if (saved.Parameter?.Value !== value || saved.Parameter?.Type !== 'SecureString') {
    throw new Error('Stored parameter verification failed');
  }
  console.log(`Stored and verified ${name}, SecureString version ${result.Version}.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
