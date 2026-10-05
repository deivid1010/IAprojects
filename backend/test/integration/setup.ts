import { loadEnvFile } from 'node:process';

// Carga backend/.env si existe; en CI las variables pueden venir del entorno.
try {
  loadEnvFile('.env');
} catch {
  // sin .env: se usan las variables ya definidas
}
