import type { NextConfig } from 'next';

const backend = process.env.ALTEGRO_API_ORIGIN || 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/health', destination: `${backend}/health` },
      { source: '/ready', destination: `${backend}/ready` }
    ];
  }
};

export default nextConfig;
