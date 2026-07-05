import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme/palette.css';
import './theme/base.css';

const container = document.getElementById('root');
if (!container) throw new Error('marifold: #root container missing');
createRoot(container).render(<App />);
