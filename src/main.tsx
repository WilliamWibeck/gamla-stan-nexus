import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode double-mounting breaks Mapbox GL worker lifecycle in dev; the map still benefits from production checks via build.
createRoot(document.getElementById('root')!).render(<App />)
