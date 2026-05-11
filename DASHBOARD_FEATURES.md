# CareU Platform - Dashboard Documentation

A modern, responsive dashboard for tailoring and repair businesses built with Next.js, React, TypeScript, and Tailwind CSS.

## 🎯 Features

### 1. **Dashboard Overview**
- Real-time sales metrics and key performance indicators (KPIs)
- Daily sales summary with revenue tracking
- Weekly and monthly statistics
- Quick overview of recent repair orders
- Responsive card layout that adapts to mobile devices

### 2. **Customer Management**
- Complete customer database
- Add, edit, and delete customers
- Track customer contact information (phone, email, address)
- View customer order history
- Track total spending per customer
- Search and filter capabilities

### 3. **Repair Orders Management**
- Create and manage repair orders
- Track order status (Pending, In Progress, Completed, Ready for Pickup)
- Add multiple items per order with individual pricing
- Calculate order totals automatically
- View order history and details
- Date tracking (created and completed dates)

### 4. **Invoice System**
- Generate invoices for repair orders
- Track payment status (Pending, Paid, Partial)
- Calculate subtotals, taxes, and totals
- Mark invoices as paid
- View payment history
- Professional invoice formatting

### 5. **Daily Sales Summary**
- Daily revenue tracking
- Order count and completion metrics
- Average order value calculations
- Sales trends visualization
- Weekly and monthly summaries

### 6. **Responsive Mobile Design**
- Mobile-first approach
- Hamburger menu for navigation on mobile
- Responsive table layouts
- Touch-friendly buttons and controls
- Optimized for screens from 320px to 4K

### 7. **Thai Language UI**
- Complete Thai language support
- Easy language switching (Thai/English)
- Thai date formatting (with Buddhist Era years)
- Thai currency formatting (฿ Baht)
- Localized interface elements

### 8. **Modern Tailwind CSS Design**
- Clean, professional interface
- Consistent color scheme (Blue primary, supporting colors)
- Smooth transitions and hover effects
- Accessible form controls
- Modern card-based layouts
- Gradient backgrounds and depth effects

## 📁 Project Structure

```
careu-platform/
├── app/
│   ├── layout.tsx              # Root layout with providers
│   ├── page.tsx                # Dashboard home page
│   ├── customers/
│   │   └── page.tsx            # Customer management
│   ├── orders/
│   │   └── page.tsx            # Repair orders
│   ├── invoices/
│   │   └── page.tsx            # Invoice system
│   └── globals.css             # Global styles
├── components/
│   ├── Sidebar.tsx             # Navigation sidebar
│   ├── StatCard.tsx            # Metric card component
│   ├── Table.tsx               # Reusable table component
│   └── Modal.tsx               # Modal dialog component
├── lib/
│   ├── languageContext.tsx     # Language provider
│   ├── translations.ts         # Thai/English translations
│   ├── mockData.ts             # Sample data
│   └── utils.ts                # Utility functions
└── types/
    └── index.ts                # TypeScript types
```

## 🚀 Getting Started

### Prerequisites
- Node.js 18.x or higher
- pnpm (recommended) or npm

### Installation

1. Install dependencies:
```bash
pnpm install
```

2. Run the development server:
```bash
pnpm dev
```

3. Open [http://localhost:3000](http://localhost:3000) in your browser

## 🛠️ Available Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint

## 🎨 Customization

### Changing the Color Scheme

Edit the color values in components to match your brand. Primary colors are defined in:
- `components/Sidebar.tsx` - Navigation styling
- `components/StatCard.tsx` - Card colors
- Tailwind utility classes throughout components

### Adding New Features

1. **Add a new page:**
   - Create a new folder in `app/` directory
   - Create `page.tsx` file
   - Add navigation link in `components/Sidebar.tsx`

2. **Add Thai translations:**
   - Update `lib/translations.ts`
   - Add new keys to both `th` and `en` objects

3. **Create new components:**
   - Add component file to `components/` directory
   - Use client components for interactivity
   - Import and use in pages

## 📊 Data Management

The dashboard currently uses mock data from `lib/mockData.ts`. To connect to a backend:

1. Replace mock data with API calls
2. Update types if needed
3. Handle loading and error states
4. Implement proper data fetching with hooks

Example API integration:
```typescript
const [data, setData] = useState([]);

useEffect(() => {
  fetch('/api/customers')
    .then(res => res.json())
    .then(data => setData(data));
}, []);
```

## 🌐 Language Support

The application supports both Thai and English:

- Language switcher in the sidebar
- All UI text is translated
- Date and currency formatting adapts to language
- Thai dates use Buddhist Era (2567 instead of 2024)

## 📱 Responsive Breakpoints

- **Mobile:** 320px - 640px
- **Tablet:** 641px - 1024px
- **Desktop:** 1025px+

## 🔒 Security Considerations

For production use:
- Implement authentication and authorization
- Validate all user inputs
- Use environment variables for sensitive data
- Implement proper error handling
- Add data encryption for sensitive information

## 📝 License

This project is private and intended for CareU business use.

## 🤝 Support

For questions or issues, please contact the development team.

---

**Built with ❤️ using Next.js, React, and Tailwind CSS**
