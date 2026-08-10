/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker is the only target: infra/Dockerfile.web copies .next/standalone and
  // runs server.js, which needs the whole traced dependency set in one place.
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@kan/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
