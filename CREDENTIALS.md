# Secure Gmail Credentials Setup

This project uses AWS Systems Manager Parameter Store to securely store Gmail OAuth2 credentials instead of environment variables.

## Why Parameter Store?

- **Encrypted at rest**: Credentials are encrypted using AWS KMS
- **Access control**: IAM policies control who can access the parameters
- **Audit trail**: All access is logged in CloudTrail
- **No exposure**: Credentials never appear in environment variables or logs

## Setup Instructions

### 1. Install Dependencies

Make sure you have the AWS SDK installed:
```bash
npm install @aws-sdk/client-ssm
```

### 2. Configure AWS Credentials

Ensure you have AWS credentials configured with access to the `eu-west-2` region:
```bash
aws configure
```

### 3. Run the Setup Script

Use the provided setup script to store your Gmail credentials:
```bash
node setup-credentials.js
```

The script will prompt you for:
- Gmail Client ID
- Gmail Client Secret (hidden input)
- Gmail Refresh Token (hidden input)  
- Gmail Sender Email

### 4. Deploy the Function

After storing credentials, deploy your function:
```bash
npx serverless deploy
```

## How It Works

1. The Lambda function attempts to fetch credentials from Parameter Store at runtime
2. If Parameter Store is unavailable (e.g., local development), it falls back to environment variables
3. All credentials are fetched in a single API call for efficiency
4. Credentials are cached for the duration of the Lambda execution

## Parameter Names

The following parameters are stored in Parameter Store:
- `/{service-name}/gmail-client-id`
- `/{service-name}/gmail-client-secret`
- `/{service-name}/gmail-refresh-token`
- `/{service-name}/gmail-sender`

## Local Development

For local development, you can still use environment variables:
```bash
export GMAIL_CLIENT_ID="your-client-id"
export GMAIL_CLIENT_SECRET="your-client-secret"
export GMAIL_REFRESH_TOKEN="your-refresh-token"
export GMAIL_SENDER="your-email@gmail.com"
```

The code will automatically fall back to these if Parameter Store is unavailable.

## Security Best Practices

1. **Least Privilege**: The Lambda function only has permission to read parameters under `/{service-name}/*`
2. **Encryption**: All parameters use `SecureString` type with KMS encryption
3. **No Logging**: Credentials are never logged or exposed in error messages
4. **Rotation**: You can easily rotate credentials by updating the parameters

## Troubleshooting

If you encounter issues:

1. **Permission Denied**: Ensure your AWS credentials have `ssm:GetParameter` and `ssm:GetParameters` permissions
2. **Region Mismatch**: Make sure you're storing parameters in the same region as your Lambda function (`eu-west-2`)
3. **Parameter Not Found**: Verify the parameter names match exactly (case-sensitive)

## Manual Parameter Creation

You can also create parameters manually via AWS CLI:
```bash
aws ssm put-parameter \
  --name "/gravesham-bin-days/gmail-client-id" \
  --value "your-client-id" \
  --type "SecureString" \
  --region eu-west-2

aws ssm put-parameter \
  --name "/gravesham-bin-days/gmail-client-secret" \
  --value "your-client-secret" \
  --type "SecureString" \
  --region eu-west-2

aws ssm put-parameter \
  --name "/gravesham-bin-days/gmail-refresh-token" \
  --value "your-refresh-token" \
  --type "SecureString" \
  --region eu-west-2

aws ssm put-parameter \
  --name "/gravesham-bin-days/gmail-sender" \
  --value "your-email@gmail.com" \
  --type "SecureString" \
  --region eu-west-2
```
