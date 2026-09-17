import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API and hosted-media routes to the Route server (npm run server).
const server = process.env.ROUTE_SERVER || 'http://127.0.0.1:5275';
export default defineConfig({ plugins: [react()], server: { proxy: { '/api': server, '/m': server, '/i': server } } });
