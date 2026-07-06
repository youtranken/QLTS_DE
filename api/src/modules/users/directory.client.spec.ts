import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DirectoryClient } from './directory.client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('DirectoryClient (story 1.3 — sau review)', () => {
  const oidc = { clientCredentialsToken: jest.fn() };
  let client: DirectoryClient;
  let fetchMock: jest.SpyInstance;

  beforeAll(() => {
    process.env.PMH_ISSUER_URL = 'https://id.test/oidc';
  });
  afterAll(() => {
    delete process.env.PMH_ISSUER_URL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    oidc.clientCredentialsToken.mockResolvedValue('m2m-1');
    client = new DirectoryClient(oidc as never);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('mảng phẳng → một vòng, trả đủ user', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ id: 'a', status: 'active', groups: [] }]),
    );
    const users = await client.fetchUsers();
    expect(users).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('API dạng {data} bỏ qua param page (trả mãi cùng dữ liệu) → dừng nhờ dedupe, KHÔNG vòng vô hạn', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a', status: 'active', groups: [] }] }),
    );
    const users = await client.fetchUsers();
    expect(users).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('body {data} không phải mảng → trả rỗng, không TypeError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { weird: true } }));
    await expect(client.fetchUsers()).resolves.toEqual([]);
  });

  it('HTTP 200 nhưng body không phải JSON → DIRECTORY_UNAVAILABLE có message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    });
    await expect(client.fetchGroups()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('401 lần đầu → retry MỘT lần với token force-refresh; vẫn 401 → DIRECTORY_AUTH_FAILED', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(client.fetchGroups()).rejects.toThrow(BadGatewayException);
    expect(oidc.clientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(oidc.clientCredentialsToken).toHaveBeenNthCalledWith(1, false);
    expect(oidc.clientCredentialsToken).toHaveBeenNthCalledWith(2, true);
  });

  it('401 lần đầu, token mới thành công → trả dữ liệu bình thường', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse([{ id: 'g1', name: 'Dev' }]));
    const groups = await client.fetchGroups();
    expect(groups).toEqual([{ id: 'g1', name: 'Dev' }]);
  });

  it('lỗi mạng → DIRECTORY_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.fetchGroups()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('HTTP 500 → DIRECTORY_UNAVAILABLE kèm status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    await expect(client.fetchGroups()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
