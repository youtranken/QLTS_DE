# ---- build ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM nginx:1.29-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY proxy-api-headers.conf /etc/nginx/proxy-api-headers.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
