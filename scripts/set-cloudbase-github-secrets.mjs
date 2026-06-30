import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

const environment = process.argv[2] || 'test';
const repo = process.env.GITHUB_REPOSITORY || 'vibelingan/channel';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function askHidden(query) {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output, terminal: true });
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function writeToOutput(value) {
      if (rl.stdoutMuted && value !== '\n' && value !== '\r\n') {
        rl.output.write('*');
        return;
      }
      originalWrite.call(rl, value);
    };

    rl.stdoutMuted = true;
    rl.question(query, (answer) => {
      rl.stdoutMuted = false;
      output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

function setSecret(name, value) {
  if (!value) throw new Error(`${name} cannot be empty.`);
  run('gh', ['secret', 'set', name, '--repo', repo, '--env', environment], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(`${name}: updated in GitHub Environment ${environment}`);
}

console.log(`Setting CloudBase deploy credentials for ${repo} environment ${environment}.`);
console.log('Paste permanent CAM credentials here. They will not be printed.');
console.log('Do not paste temporary STS credentials or a SessionToken.');

const secretId = await askHidden('TENCENTCLOUD_SECRETID: ');
const secretKey = await askHidden('TENCENTCLOUD_SECRETKEY: ');

setSecret('TENCENTCLOUD_SECRETID', secretId);
setSecret('TENCENTCLOUD_SECRETKEY', secretKey);

const deleteResult = spawnSync(
  'gh',
  ['secret', 'delete', 'TENCENTCLOUD_SESSIONTOKEN', '--repo', repo, '--env', environment],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (deleteResult.status === 0) {
  console.log(`TENCENTCLOUD_SESSIONTOKEN: deleted from GitHub Environment ${environment}`);
} else {
  const output = `${deleteResult.stdout ?? ''}${deleteResult.stderr ?? ''}`;
  if (/not found|could not resolve to a secret/i.test(output)) {
    console.log(`TENCENTCLOUD_SESSIONTOKEN: already absent from GitHub Environment ${environment}`);
  } else {
    throw new Error(`Failed to delete TENCENTCLOUD_SESSIONTOKEN: ${output.trim()}`);
  }
}

console.log('CloudBase deploy credentials are ready for the next Deploy Test run.');
