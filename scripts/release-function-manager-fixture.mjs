import { spawnSync } from 'node:child_process';
import CloudBase from '@cloudbase/manager-node';

export function functionZip(code = 'exports.main = async () => ({ok:true});', extra = {}) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      "import io,json,sys,zipfile; f=json.load(sys.stdin); b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); [(z.writestr(k,v)) for k,v in f.items()]; z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    {
      input: JSON.stringify({
        'index.js': code,
        'package.json': JSON.stringify({ main: 'index.js', dependencies: {} }),
        ...extra,
      }),
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error('Fixture ZIP failed');
  return result.stdout;
}
export function functionManagerFixture({ bytes = functionZip(), name = 'public-api' } = {}) {
  const state = {
    bytes,
    calls: [],
    updates: 0,
    envId: 'fixture-env',
    namespace: 'fixture-env',
    backend: 'scf',
    updatingReads: 0,
    fail: null,
    detail: {
      FunctionName: name,
      Namespace: 'fixture-env',
      FunctionId: 'fixture-function-id',
      FunctionVersion: '$LATEST',
      Type: 'Event',
      Runtime: 'Nodejs20.19',
      Handler: 'index.main',
      Role: 'fixture-role',
      Layers: [],
      Environment: { Variables: [{ Key: 'JWT_SECRET', Value: 'sdk-fixture-secret' }] },
      VpcConfig: { VpcId: '', SubnetId: '' },
      Triggers: [],
      Status: 'Active',
      AvailableStatus: 'Available',
      CodeSize: bytes.length,
      ModTime: 'version-B',
      InstallDependency: 'TRUE',
      Timeout: 20,
      MemorySize: 256,
    },
  };
  const manager = new CloudBase({
    envId: 'fixture-env',
    region: 'ap-shanghai',
    requestFn: async ({ action, payload }) => {
      state.calls.push({ action, payload: structuredClone(payload) });
      if (action === 'DescribeEnvInfo')
        return {
          EnvInfo: {
            EnvBaseInfo: {
              EnvId: state.envId,
              Functions: [{ Namespace: state.namespace, Backend: state.backend }],
              Databases: [],
              Storages: [],
            },
          },
        };
      if (payload.EnvId !== 'fixture-env' || payload.FunctionName !== name)
        throw new Error('Foreign fixture function request');
      if (action === 'GetFunction') {
        if (state.updatingReads > 0) {
          state.updatingReads--;
          return {
            ...structuredClone(state.detail),
            Status: 'Updating',
            RequestId: 'reading-updating',
          };
        }
        return { ...structuredClone(state.detail), RequestId: 'reading-active' };
      }
      if (action === 'DownloadFunction')
        return {
          Url: 'https://code.cos.ap-shanghai.myqcloud.com/function.zip?signed=fixture-private-signature',
          RequestId: 'download-url',
        };
      if (action === 'UpdateFunctionCode') {
        state.onUpdate?.();
        if (state.holdUpdate) await state.holdUpdate;
        state.updates++;
        state.bytes = Buffer.from(payload.Code.ZipFile, 'base64');
        state.detail.CodeSize = state.bytes.length;
        state.detail.ModTime = 'version-A';
        state.detail.InstallDependency = payload.InstallDependency;
        if (state.fail === 'lost-ack')
          throw new Error('sdk-fixture-secret must not appear in logs');
        if (state.fail === 'drift') state.detail.Environment.Variables[0].Value = 'changed-secret';
        if (state.fail === 'failed-state') state.detail.Status = 'UpdateFailed';
        if (state.fail === 'updating') state.updatingReads = 2;
        if (state.fail === 'never-active') state.updatingReads = 1e9;
        if (state.fail === 'wrong-bytes') state.bytes = functionZip('exports.main = () => 2;');
        if (state.fail === 'missing-receipt') return {};
        state.onUpdateSettled?.();
        return { RequestId: 'update-code' };
      }
      throw new Error('Unexpected function fixture action');
    },
  });
  const request = async (method, url) => {
    if (method !== 'GET' || !url.startsWith('https://code.cos.ap-shanghai.myqcloud.com/'))
      throw new Error('Wrong fixture download');
    if (state.fail === 'download') throw new Error('fixture-private-signature');
    return { status: 200, body: Buffer.from(state.bytes), headers: new Headers() };
  };
  return { state, manager, request };
}
