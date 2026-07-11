// Sinh hash mật khẩu SA cục bộ để đặt vào LOCAL_SA_PASSWORD_HASH (story 10.1).
// Định dạng scrypt.<saltHex>.<hashHex> PHẢI khớp local-sa.service.ts (KEYLEN=64, SALT=16).
// Dấu '.' (không dùng '$' — docker-compose diễn giải '$' là biến).
// Dùng:  npm run sa:hash -- 'mật-khẩu-mạnh'
import { randomBytes, scryptSync } from 'node:crypto';

const pw = process.argv[2];
if (!pw) {
  console.error("Cách dùng: npm run sa:hash -- '<mật-khẩu>'");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 64);
console.log(`scrypt.${salt.toString('hex')}.${hash.toString('hex')}`);
