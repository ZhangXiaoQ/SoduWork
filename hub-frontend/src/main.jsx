import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import './styles-bugloop.css'   // Issue-resolution page styles.
import './styles-devflow.css'   // Development-flow defaults, repository overrides, and prompt preview.
import './design-system.css'    // Shared administration visual and responsive rules.
import './page-layouts.css'     // Page-specific layouts load after common controls.
import './landing.css'          // Scope the prelogin introduction independently of administration pages.

import './filter-controls.css'
import './admin-controls.css'
import './accessibility.css'
import './responsive-pages.css'
import './dialog-layout.css'
import './screens/detail-layout.css'
import './layout-safety.css'
import './console-theme.css'   // Shared operations-inspired colors and controls.
import './login-workbench.css' // Login-specific workspace layout.
import './landing-product.css' // Prelogin product page independent of login and administration views.
import './enlarge-theme.css'   // Enlarge theme (issue #27); loads after the base stylesheets it adjusts.

import { initScale } from './enlarge-theme.js'

try {
  const savedTheme = localStorage.getItem('soduwork-hub-theme')
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme)
} catch (_e) {}
initScale() // Apply the saved display-scale preference before first paint.

createRoot(document.getElementById('root')).render(<App />)

import './admin-polish.css'
