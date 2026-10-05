# --- build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# La API se llama por /api en el mismo origen (nginx la reenvía al contenedor api).
ARG VITE_API_URL=/api
ARG VITE_CLINIC_ID=clinica-vida-sana
ENV VITE_API_URL=$VITE_API_URL VITE_CLINIC_ID=$VITE_CLINIC_ID
RUN npm run build

# --- runtime: archivos estáticos con nginx ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
