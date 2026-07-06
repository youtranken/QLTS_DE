import { ArgumentsHost, HttpException } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

function mockHost(headersSent = false) {
  const response = {
    headersSent,
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('GlobalExceptionFilter — nhánh biên', () => {
  const filter = new GlobalExceptionFilter();

  it('HttpException payload null → vẫn trả đúng shape, không TypeError', () => {
    const { host, response } = mockHost();
    filter.catch(new HttpException(null as never, 400), host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: expect.any(String),
    });
  });

  it('headers đã gửi → không ghi response lần hai (tránh ERR_HTTP_HEADERS_SENT)', () => {
    const { host, response } = mockHost(true);
    filter.catch(new Error('boom'), host);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('lỗi không đoán trước → 500 INTERNAL_ERROR, không lộ chi tiết', () => {
    const { host, response } = mockHost();
    filter.catch(new Error('bí mật nội bộ'), host);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
