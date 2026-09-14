import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server output for the Docker image (apps/web/Dockerfile).
  // The tracing root is the monorepo root so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Transpile shared workspace packages so they can ship raw TypeScript.
  transpilePackages: ['@hardware-pos/shared'],
};

export default nextConfig;
