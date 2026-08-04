import type { BusinessTaxonomyIndustry } from "./types";

export const BUSINESS_TAXONOMY_PART_1: readonly BusinessTaxonomyIndustry[] = [
  {
    slug: "fashion-apparel",
    name: "Fashion & Apparel",
    verticals: [
      {
        slug: "activewear-athleisure-ecommerce",
        name: "Activewear & Athleisure Ecommerce",
      },
      {
        slug: "children-s-clothing-ecommerce",
        name: "Children's Clothing Ecommerce",
      },
      {
        slug: "clothing-apparel-retailers",
        name: "Clothing & Apparel Retailers",
      },
      {
        slug: "fashion-ecommerce",
        name: "Fashion Ecommerce",
      },
      {
        slug: "footwear-ecommerce-stores",
        name: "Footwear Ecommerce Stores",
      },
      {
        slug: "jewelry-accessories",
        name: "Jewelry & Accessories",
      },
      {
        slug: "department-stores",
        name: "Department Stores",
        description: "Large-format multi-category retailers",
      },
    ],
  },
  {
    slug: "home-living",
    name: "Home & Living",
    verticals: [
      {
        slug: "home-decor-gift-shops",
        name: "Home Decor & Gift Shops",
        description:
          "Home decor boutiques, gift shops, and specialty home goods retailers",
      },
      {
        slug: "furniture-stores",
        name: "Furniture Stores",
        description: "Home furniture and furnishings retail",
      },
    ],
  },
  {
    slug: "healthcare",
    name: "Healthcare",
    description:
      "Healthcare providers including hospitals, clinics, and medical practices",
    verticals: [
      {
        slug: "chiropractors",
        name: "Chiropractors",
        description: "Chiropractic practices and spinal care",
      },
      {
        slug: "dentists",
        name: "Dental Practices",
        description: "Dental practices and oral healthcare providers",
      },
      {
        slug: "dialysis-centers",
        name: "Dialysis Centers",
        description: "Dialysis treatment centers and renal care facilities",
      },
      {
        slug: "general-practices",
        name: "General Practices",
        description: "General practitioners and family medicine practices",
      },
      {
        slug: "home-healthcare",
        name: "Home Healthcare",
        description: "Home healthcare and in-home nursing services",
      },
      {
        slug: "hospitals",
        name: "Hospitals",
        description: "Hospitals and medical centers",
      },
      {
        slug: "medical-billing-coding-services",
        name: "Medical Billing & Coding Services",
        description:
          "Medical billing, coding, and revenue cycle management services",
      },
      {
        slug: "medical-laboratories",
        name: "Medical Laboratories",
      },
      {
        slug: "medical-specialists",
        name: "Medical Specialists",
        description: "Medical specialists and consultant doctors",
      },
      {
        slug: "medical-staffing-agencies",
        name: "Medical Staffing Agencies",
        description:
          "Healthcare staffing and temporary medical personnel services",
      },
      {
        slug: "mental-health",
        name: "Mental Health Clinics",
        description: "Mental health professionals and counseling services",
      },
      {
        slug: "occupational-health",
        name: "Occupational Health",
      },
      {
        slug: "optometrists",
        name: "Optometrists",
        description: "Optometry practices and vision care",
      },
      {
        slug: "pharmacies",
        name: "Pharmacies",
        description: "Pharmacies and dispensaries",
      },
      {
        slug: "pharmacy-health-products",
        name: "Pharmacy & Health Products",
        description: "Pharmacies, drugstores, and health product retailers",
      },
      {
        slug: "physiotherapists",
        name: "Physiotherapy Practices",
        description: "Physiotherapy practices and rehabilitation services",
      },
      {
        slug: "rehabilitation-centers",
        name: "Rehabilitation Centers",
      },
      {
        slug: "senior-care-assisted-living",
        name: "Senior Care & Assisted Living",
        description:
          "Nursing homes, assisted living facilities, and memory care centers",
      },
      {
        slug: "urgent-care-centers",
        name: "Urgent Care Centers",
        description: "Urgent care clinics and walk-in medical centers",
      },
      {
        slug: "veterinarians",
        name: "Veterinarians",
        description: "Veterinary practices and animal healthcare",
      },
    ],
  },
  {
    slug: "legal",
    name: "Legal",
    description:
      "Legal services including law firms, attorneys, and legal consultants",
    verticals: [
      {
        slug: "attorneys-law-firms",
        name: "Attorneys & Law Firms",
        description:
          "South Africa's legal practitioners who provide general legal services across multiple practice areas. Regulated by the Legal Practice Council, attorneys represent approximately 27,000+ professionals managing client matters across corporate, commercial, litigation, and transactional work.",
      },
      {
        slug: "compliance-regulatory",
        name: "Compliance & Regulatory",
        description:
          "Regulatory compliance, government relations, and administrative law",
      },
      {
        slug: "conveyancers",
        name: "Conveyancers",
      },
      {
        slug: "corporate-lawyers",
        name: "Corporate Lawyers",
        description:
          "Mid to large corporate law firms specializing in commercial, M&A, and corporate governance",
      },
      {
        slug: "criminal-defense-lawyers",
        name: "Criminal Defense Lawyers",
        description: "Criminal defense attorneys",
      },
      {
        slug: "debt-collectors",
        name: "Debt Collectors",
        description:
          "Legal practitioners specializing in debt collection, insolvency, and credit law working with the National Credit Regulator framework. This vertical manages consumer debt recovery, commercial debt, and credit-related disputes for corporate clients and financial institutions.",
      },
      {
        slug: "employment-labour-law",
        name: "Employment & Labour Law",
        description:
          "Employment law, labour disputes, and workplace legal services",
      },
      {
        slug: "environmental-lawyers",
        name: "Environmental Lawyers",
        description:
          "Attorneys specializing in environmental law, regulatory compliance, and EIA processes under NEMA (National Environmental Management Act) and sector-specific environmental legislation. This vertical advises on waste management, pollution control, environmental impact assessments, and regulatory compliance for mining, energy, and development projects.",
      },
      {
        slug: "family-lawyers",
        name: "Family Lawyers",
        description:
          "Attorneys specializing in family law including divorce, maintenance, child custody, matrimonial property division, and family dispute resolution. Practitioners navigate the Divorce Act, Maintenance Act, Childrens Act, and Matrimonial Property Act while managing emotionally charged client relationships.",
      },
      {
        slug: "immigration-lawyers",
        name: "Immigration Lawyers",
        description: "Immigration and visa attorneys",
      },
      {
        slug: "intellectual-property-lawyers",
        name: "Intellectual Property Lawyers",
        description: "Intellectual property and patent attorneys",
      },
      {
        slug: "legal-aid",
        name: "Legal Aid",
      },
      {
        slug: "litigation-dispute-resolution",
        name: "Litigation & Dispute Resolution",
        description:
          "Commercial litigation, arbitration, and mediation services",
      },
      {
        slug: "mediators-arbitrators",
        name: "Mediators & Arbitrators",
        description:
          "Dispute resolution professionals offering mediation and arbitration services as alternative dispute resolution (ADR) methods. This vertical addresses court backlogs, provides confidential dispute resolution, and includes AFSA, CCMA, and private mediators.",
      },
      {
        slug: "notaries-public",
        name: "Notaries Public",
        description: "Notaries and conveyancing services",
      },
      {
        slug: "personal-injury-lawyers",
        name: "Personal Injury Lawyers",
        description: "Personal injury and accident attorneys",
      },
      {
        slug: "real-estate-property-law",
        name: "Real Estate & Property Law",
        description:
          "Property transactions, landlord-tenant law, and real estate attorneys",
      },
      {
        slug: "tax-estate-planning",
        name: "Tax & Estate Planning",
        description: "Tax attorneys, estate planning, and trust services",
      },
    ],
  },
  {
    slug: "financial-services",
    name: "Finance",
    description:
      "Financial institutions, banks, and financial advisory services",
    verticals: [
      {
        slug: "accounting-audit-firms",
        name: "Accounting & Audit Firms",
        description:
          "Chartered accountant firms, audit practices, and tax advisory services",
      },
      {
        slug: "banks",
        name: "Banks & Credit Unions",
        description: "Commercial and retail banks",
      },
      {
        slug: "credit-bureaus",
        name: "Credit Bureaus",
      },
      {
        slug: "financial-advisors-wealth-managers",
        name: "Financial Advisors & Wealth Managers",
        description: "Financial advisors and wealth management",
      },
      {
        slug: "fintech-companies",
        name: "Fintech Companies",
      },
      {
        slug: "forex-brokers",
        name: "Forex Brokers",
        description: "Foreign exchange and currency trading",
      },
      {
        slug: "insurance-brokers-agents",
        name: "Insurance Brokers & Agents",
        description: "Independent insurance brokers and agents",
      },
      {
        slug: "insurance-companies",
        name: "Insurance Companies",
        description: "Life, health, property, and casualty insurance providers",
      },
      {
        slug: "investment-advisors-asset-managers",
        name: "Investment Advisors & Asset Managers",
      },
      {
        slug: "microfinance-lending-firms",
        name: "Microfinance & Lending Firms",
      },
      {
        slug: "mortgage-brokers",
        name: "Mortgage Brokers",
        description: "Mortgage brokers and home loan specialists",
      },
      {
        slug: "payment-processing-companies",
        name: "Payment Processing Companies",
        description: "Payment gateways, merchant services, and POS providers",
      },
      {
        slug: "stock-brokers-trading-firms",
        name: "Stock Brokers & Trading Firms",
        description: "Securities brokers and trading platforms",
      },
      {
        slug: "tax-consultants",
        name: "Tax Consultants",
        description: "Tax consulting and compliance services",
      },
      {
        slug: "venture-capital-private-equity",
        name: "Venture Capital & Private Equity",
        description: "VC firms and private equity investment companies",
      },
    ],
  },
  {
    slug: "real-estate",
    name: "Real Estate",
    description: "Real estate agencies, property management, and development",
    verticals: [
      {
        slug: "commercial-real-estate-office-retail-properties",
        name: "Commercial Real Estate (Office & Retail Properties)",
        description:
          "Commercial office and retail real estate in South Africa valued at $9.99 billion, growing 7.61% CAGR. Office segment leads with 38.65% revenue share. Cape Town office vacancy at 15-year low. Retail bifurcating: convenience centres thriving while regional malls face e-commerce disruption from R26bn+ online retail.",
      },
      {
        slug: "industrial-real-estate",
        name: "Industrial Real Estate",
      },
      {
        slug: "property-development",
        name: "Property Development",
        description:
          "Property development in South Africa including residential, mixed-use, and commercial projects. Market driven by estate living growth (490,000 properties), mixed-use development demand, coastal migration from remote work, and green building requirements (70% of new developments). Key challenge: municipal approval delays of 6-12+ months.",
      },
      {
        slug: "property-management-commercial",
        name: "Property Management (Commercial)",
        description:
          "Commercial property management for office, retail, and industrial assets in South Africa. Market driven by smart building technology adoption, ESG reporting requirements, tenant retention criticality, and energy cost management during SA electricity crisis. Key challenges: multi-tenant coordination, energy optimization, and sustainability reporting.",
      },
      {
        slug: "property-management-residential",
        name: "Property Management (Residential)",
        description:
          "Residential property management in South Africa including body corporates, HOAs, estate management, and tenant relations. Market driven by estate living growth (490,000 properties), POPIA April 2025 compliance urgency, and digital transformation. Key regulations: Sectional Titles Schemes Management Act, POPIA Residential Communities Code.",
      },
      {
        slug: "property-valuations-appraisal-services",
        name: "Property Valuations & Appraisal Services",
        description:
          "Property valuation and appraisal services in South Africa for residential, commercial, and specialized assets. Market driven by IVSC compliance adoption, AVM technology integration, portfolio valuations for REITs and funds, and mortgage lending requirements. Key regulator: SACPVP (South African Council for Property Valuers Profession).",
      },
      {
        slug: "proptech-real-estate-technology",
        name: "PropTech & Real Estate Technology",
        description:
          "Property technology (PropTech) in South Africa including digital platforms, marketplaces, property management software, smart building technology, and real estate fintech. Market driven by digital transformation, estate agent technology adoption, and tenant experience platforms. Key players: Property24, Private Property, Flow, PayProp, Prop Data.",
      },
      {
        slug: "real-estate-attorneys",
        name: "Real Estate Attorneys",
      },
      {
        slug: "real-estate-financing-mortgage-services",
        name: "Real Estate Financing & Mortgage Services",
        description:
          "Property finance and mortgage services in South Africa including home loans, commercial property lending, and development finance. Market driven by interest rate cuts to 10.75% (predicted 10.50% by end-2025), First Home Finance subsidy expansion, and 86% estate agent confidence. Key players: Ooba, Standard Bank, Nedbank, FNB, ABSA.",
      },
      {
        slug: "real-estate-investment",
        name: "Real Estate Investment",
        description:
          "Real Estate Investment Trusts (REITs) and property funds in South Africa. Market features 23 REIT members on JSE, with $9.99B commercial market. SA REITs forecast as top pick for 2025 with 14.7-22.5% shareholder returns. Key players: Equites (logistics R28.3bn), Vukile (retail R54bn), Stor-Age (niche REIT). Cross-border investment emerging.",
      },
      {
        slug: "real-estate-marketing-photography",
        name: "Real Estate Marketing & Photography",
        description:
          "Specialized marketing services, virtual tours, and professional photography for property listings",
      },
      {
        slug: "residential-real-estate-estate-agents-property-sales",
        name: "Residential Real Estate (Estate Agents & Property Sales)",
        description:
          "Estate agents and property sales in South Africa's residential market valued at R850 billion. Market recovering with 86% agent confidence, driven by interest rate cuts to 10.75%, first-time buyer subsidies, and coastal migration from remote work. Key regulations: EAAB licensing, POPIA April 2025 amendments, Sectional Titles Act.",
      },
      {
        slug: "title-escrow-services",
        name: "Title & Escrow Services",
        description:
          "Title insurance companies and escrow service providers for real estate transactions",
      },
      {
        slug: "shopping-centers",
        name: "Shopping Centers",
        description:
          "Shopping malls, retail centers, and mixed-use retail complexes that house multiple retail tenants",
      },
    ],
  },
];
