/**
 * Entry point. Mounts <App /> and pulls in the two stylesheets that must load
 * before anything renders: Esri's light theme (widget chrome) and then our own
 * tokens, which re-point Calcite variables at the MARC palette — order
 * matters, ours has to win.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@arcgis/core/assets/esri/themes/light/main.css'
import './styles/global.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
