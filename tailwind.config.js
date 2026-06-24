/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  corePlugins: {
    preflight: false, // Don't reset existing app styles
  },
  theme: { extend: {} },
  plugins: [],
}
