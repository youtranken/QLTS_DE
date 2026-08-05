# Image backup QLTS: pg_dump (postgres 18) + openssl bake sẵn (offline vẫn backup được).
FROM postgres:18-alpine
RUN apk add --no-cache openssl
COPY backup.sh /backup.sh
COPY cron-loop.sh /cron-loop.sh
ENTRYPOINT ["sh", "/backup.sh"]
