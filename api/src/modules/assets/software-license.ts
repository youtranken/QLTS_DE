import { BadRequestException } from '@nestjs/common';
import type { AssetInput } from './assets.service';

/**
 * Validate luật phần mềm/license (2.4, FR-38 + sw-license-model-redesign) — tách khỏi
 * assets.service (CLAUDE.md §6: một trách nhiệm/file). license_name là ĐỊNH DANH phần mềm
 * (thay mã tài sản) → mọi loại license đều bắt buộc; máy (non-software) bắt buộc `code`.
 */
export function validateSoftwareInput(input: AssetInput): void {
  const bad = (code: string, message: string) => {
    throw new BadRequestException({ code, message });
  };
  if (input.type === 'software') {
    if (!input.licenseName) {
      bad('LICENSE_NAME_REQUIRED', 'Phần mềm phải có tên license.');
    }
    if (input.licenseType !== 'term' && input.licenseType !== 'perpetual') {
      bad(
        'LICENSE_TYPE_REQUIRED',
        'Phần mềm phải chọn loại license: có thời hạn hoặc vĩnh viễn.',
      );
    }
    if (input.licenseType === 'term' && !input.endDate) {
      bad(
        'LICENSE_END_DATE_REQUIRED',
        'License có thời hạn phải có ngày hết hạn.',
      );
    }
    if (input.licenseType === 'perpetual' && input.endDate) {
      bad('LICENSE_PERPETUAL_NO_END', 'License vĩnh viễn không có ngày hết hạn.');
    }
  } else {
    // Máy (không phải phần mềm) BẮT BUỘC có mã (code đã nullable ở DB — chốt tại đây).
    if (!input.code) {
      bad('CODE_REQUIRED', 'Tài sản phải có mã.');
    }
    if (input.licenseType || input.licenseName) {
      bad(
        'SOFTWARE_FIELDS_ONLY',
        'Trường license chỉ dành cho bản ghi phần mềm.',
      );
    }
  }
}
