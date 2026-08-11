import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import ErrorBoundary from './components/main-content/view/ErrorBoundary'
import './index.css'

// Initialize i18n
import './i18n/config.js'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary showDetails>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
