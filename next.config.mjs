/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Playwright is gone from the Next.js bundle entirely: the scraper runs in the
  // GitHub Actions worker, not in an API route. It stays a devDependency so
  // Vercel's production install never pulls it, and no route imports it.
  // exceljs still needs the escape hatch — it is loaded lazily by the export
  // writers and webpack cannot follow that.
  serverExternalPackages: ['exceljs'],

  eslint: {
    // The scraper predates this config and is linted by tsc, not eslint.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
