const { GetParameterCommand } = require('@aws-sdk/client-ssm');

const DEFAULT_CONFIG_PARAMETER = '/gravesham-bin-days/recipients-config';

function validateRecipientsConfig(config) {
  if (!config || !Array.isArray(config.addresses) || config.addresses.length === 0) {
    throw new Error('Recipient config must contain a nonempty addresses array');
  }
  if (config.timezone !== undefined) {
    try {
      if (typeof config.timezone !== 'string' || !config.timezone.trim()) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: config.timezone });
    } catch {
      throw new Error('Recipient config timezone must be a valid timezone');
    }
  }
  const emailLike = value => typeof value === 'string' && /.+@.+\..+/.test(value);
  const validRecipient = recipient => {
    if (typeof recipient === 'string') {
      return emailLike(recipient) || recipient.trim().toLowerCase() === 'buttondown';
    }
    if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return false;
    const type = String(recipient.type || recipient.channel || '').trim().toLowerCase();
    return type === 'buttondown' || recipient.buttondown === true ||
      (['', 'email', 'gmail', 'direct'].includes(type) && emailLike(recipient.email || recipient.address));
  };
  for (const [index, address] of config.addresses.entries()) {
    if (!address || typeof address.label !== 'string' || !address.label.trim() ||
        !Array.isArray(address.recipients) || address.recipients.length === 0 ||
        !address.recipients.every(validRecipient)) {
      throw new Error(`Recipient config address at index ${index} needs a label and valid recipients`);
    }
  }
  return config;
}

function parseRecipientsConfig(value) {
  let config;
  try {
    config = JSON.parse(value);
  } catch {
    // JSON parser messages can include private snippets of the parameter value.
    throw new Error('Recipient configuration must contain valid JSON');
  }
  return validateRecipientsConfig(config);
}

async function loadRecipientsConfig(client, parameterName = DEFAULT_CONFIG_PARAMETER) {
  const response = await client.send(new GetParameterCommand({
    Name: parameterName,
    WithDecryption: true
  }));
  if (!response.Parameter?.Value) throw new Error('Recipient configuration parameter is empty');
  return parseRecipientsConfig(response.Parameter.Value);
}

module.exports = { DEFAULT_CONFIG_PARAMETER, loadRecipientsConfig, parseRecipientsConfig, validateRecipientsConfig };
