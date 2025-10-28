#!/usr/bin/env node

/**
 * Script to securely store Gmail credentials in AWS Parameter Store
 * 
 * Usage:
 *   node setup-credentials.js
 * 
 * This script will prompt you to enter your Gmail credentials and store them
 * securely in AWS Systems Manager Parameter Store with encryption.
 */

const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ssm = new SSMClient({ region: 'eu-west-2' });

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function askSecretQuestion(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let input = '';
    
    process.stdin.on('data', (char) => {
      char = char.toString();
      
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') { // Ctrl+C
        process.exit();
      } else if (char === '\u007f') { // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    });
  });
}

async function storeParameter(name, value, description) {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Description: description,
    Type: 'SecureString', // Encrypted at rest
    Overwrite: true
  });
  
  try {
    await ssm.send(command);
    console.log(`✓ Stored parameter: ${name}`);
  } catch (error) {
    console.error(`✗ Failed to store parameter ${name}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('Gmail Credentials Setup for AWS Parameter Store');
  console.log('==============================================\n');
  
  console.log('This script will securely store your Gmail OAuth2 credentials in AWS Parameter Store.');
  console.log('Make sure you have AWS credentials configured and access to eu-west-2 region.\n');
  
  const serviceName = 'gravesham-bin-days';
  
  try {
    const clientId = await askQuestion('Enter Gmail Client ID: ');
    const clientSecret = await askSecretQuestion('Enter Gmail Client Secret (hidden): ');
    const refreshToken = await askSecretQuestion('Enter Gmail Refresh Token (hidden): ');
    const sender = await askQuestion('Enter Gmail Sender Email: ');
    
    console.log('\nStoring credentials in Parameter Store...\n');
    
    await storeParameter(
      `/${serviceName}/gmail-client-id`,
      clientId,
      'Gmail OAuth2 Client ID for bin day notifications'
    );
    
    await storeParameter(
      `/${serviceName}/gmail-client-secret`, 
      clientSecret,
      'Gmail OAuth2 Client Secret for bin day notifications'
    );
    
    await storeParameter(
      `/${serviceName}/gmail-refresh-token`,
      refreshToken,
      'Gmail OAuth2 Refresh Token for bin day notifications'
    );
    
    await storeParameter(
      `/${serviceName}/gmail-sender`,
      sender,
      'Gmail sender email address for bin day notifications'
    );
    
    console.log('\n✅ All Gmail credentials stored successfully!');
    console.log('\nYour credentials are now securely stored in AWS Parameter Store with encryption.');
    console.log('The Lambda function will fetch them automatically at runtime.');
    console.log('\nYou can now deploy your function with: npx serverless deploy');
    
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main();
}
