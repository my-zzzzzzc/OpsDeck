import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Root } from './Root'
import { ThemeProvider } from './theme'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>,
)
