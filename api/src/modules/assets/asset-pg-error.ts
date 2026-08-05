import { BadRequestException, ConflictException } from '@nestjs/common';

interface PgError {
  code?: string;
  constraint?: string;
}

/**
 * Map lỗi Postgres → lỗi nghiệp vụ (dùng chung create/update/lifecycle ở AssetsService và
 * transferLicense ở AssetSoftwareService); lỗi khác giữ nguyên cho filter 500.
 */
export function mapAssetPgError(error: unknown): unknown {
  const pg = (
    error instanceof Error && 'cause' in error && error.cause
      ? error.cause
      : error
  ) as PgError;
  if (pg?.code === '23505' && pg.constraint === 'assets_code_key') {
    return new ConflictException({
      code: 'CODE_TAKEN',
      message: 'Mã tài sản đã tồn tại — mã phải duy nhất.',
    });
  }
  // Chặn trùng seat: cùng phần mềm (license_name) trên CÙNG 1 máy (uq_software_per_machine).
  if (pg?.code === '23505' && pg.constraint === 'uq_software_per_machine') {
    return new ConflictException({
      code: 'SOFTWARE_ALREADY_ON_MACHINE',
      message: 'Máy này đã cài phần mềm này rồi — không thêm bản trùng.',
    });
  }
  if (pg?.code === '23503') {
    if (pg.constraint === 'assets_installed_on_asset_id_fkey') {
      return new BadRequestException({
        code: 'INSTALL_TARGET_NOT_FOUND',
        message: 'Máy để cài phần mềm không tồn tại.',
      });
    }
    return new BadRequestException({
      code: 'ASSIGNEE_NOT_FOUND',
      message: 'Người đứng tên không tồn tại trong hệ thống.',
    });
  }
  if (pg?.code === '23514') {
    if (pg.constraint === 'assets_code_required_nonsoftware') {
      return new BadRequestException({
        code: 'CODE_REQUIRED',
        message: 'Tài sản (không phải phần mềm) phải có mã.',
      });
    }
    // CHECK 0012 là chốt cuối — app validate đã trả message đẹp trước đó
    return new BadRequestException({
      code: 'CONSTRAINT_VIOLATION',
      message: 'Dữ liệu vi phạm ràng buộc phần mềm/license.',
    });
  }
  if (pg?.code === '22007' || pg?.code === '22008') {
    return new BadRequestException({
      code: 'BAD_DATE',
      message: 'Ngày không hợp lệ.',
    });
  }
  return error;
}
