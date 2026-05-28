import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="text-center py-16">
      <h1 className="text-5xl font-bold text-gray-200 mb-4">404</h1>
      <p className="text-gray-600 mb-6">Page not found.</p>
      <Link to="/" className="text-indigo-600 hover:underline">Back to home</Link>
    </div>
  );
}
