import { Routes, Route } from 'react-router-dom';
import AppShell from './components/layout/AppShell.js';
import OntologyBuilderPage from './pages/OntologyBuilderPage.js';
import SchemaMappingPage from './pages/SchemaMappingPage.js';
import ShexMappingPage from './pages/ShexMappingPage.js';
import NotFoundPage from './pages/NotFoundPage.js';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OntologyBuilderPage />} />
        <Route path="/ontology" element={<OntologyBuilderPage />} />
        <Route path="/ontology/:id" element={<OntologyBuilderPage />} />
        <Route path="/mapping" element={<SchemaMappingPage />} />
        <Route path="/shex" element={<ShexMappingPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
