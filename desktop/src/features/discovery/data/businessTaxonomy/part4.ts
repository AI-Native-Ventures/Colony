import type { BusinessTaxonomyIndustry } from "./types";

export const BUSINESS_TAXONOMY_PART_4: readonly BusinessTaxonomyIndustry[] = [
  {
    slug: "security",
    name: "Security",
    description: "Security services, protection, and safety companies",
    verticals: [
      {
        slug: "armed-response-monitoring",
        name: "Armed Response & Monitoring",
        description:
          "24/7 armed response teams, monitoring center operations, panic button response, and rapid emergency dispatch. Average armed response costs R700-800/month. Sub-5-minute response time targets. High demand due to crime rates in Gauteng, Western Cape, and KZN.",
      },
      {
        slug: "cash-in-transit-asset-protection",
        name: "Cash-in-Transit & Asset Protection",
        description: "Armored vehicle services and secure cash handling",
      },
      {
        slug: "cybersecurity",
        name: "Cybersecurity",
        description:
          "Digital security, threat detection, and cyber defense services",
      },
      {
        slug: "electronic-security-systems",
        name: "Electronic Security Systems",
        description: "Access control and biometric systems",
      },
      {
        slug: "event-security",
        name: "Event Security",
        description:
          "Security services for events, venues, and temporary installations",
      },
      {
        slug: "guarding-services",
        name: "Guarding Services",
        description:
          "Physical security personnel for residential, commercial, retail, and industrial facilities. South Africa has the largest private security industry globally relative to population with 4:1 personnel to police ratio. Market driven by SAPS capacity constraints, load shedding vulnerabilities, and high crime rates in Gauteng, Western Cape, and KwaZulu-Natal.",
      },
      {
        slug: "security-consulting-risk-assessment",
        name: "Security Consulting & Risk Assessment",
        description:
          "Security risk assessment, design, and consulting services",
      },
      {
        slug: "security-technology-integration",
        name: "Security Technology & Integration",
        description:
          "Systems integration, platform development, AI/ML security solutions, IoT deployment, and security architecture consulting. South Africa leads African AI adoption with 60% data centre market share. Government implemented 23 AI tools in 2025. Strong demand for integrated security ecosystems.",
      },
      {
        slug: "security-training-compliance",
        name: "Security Training & Compliance",
        description:
          "PSIRA training, security officer certification, compliance training, advanced specialization courses, and professional development. Multiple PSIRA-accredited training centers. Certification levels from Grade E to Grade A. 7% mandated annual wage increase affects training budgets.",
      },
      {
        slug: "vip-protection-executive-security",
        name: "VIP Protection & Executive Security",
        description:
          "Close protection services, threat assessment, security detail deployment, secure transport, and dignitary protection. Government spends R1.5B annually on VIP protection. High-profile kidnapping risks in Gauteng and KZN. Corporate executive threat levels increasing.",
      },
    ],
  },
  {
    slug: "automotive",
    name: "Automotive",
    description: "Automotive dealerships, repair, and vehicle services",
    verticals: [
      {
        slug: "auto-manufacturing",
        name: "Auto Manufacturing",
        description: "Vehicle manufacturers and assembly plants",
      },
      {
        slug: "auto-parts-stores",
        name: "Auto Parts Stores",
      },
      {
        slug: "auto-parts-suppliers",
        name: "Auto Parts Suppliers",
        description: "Wholesale and retail automotive parts distributors",
      },
      {
        slug: "auto-repair",
        name: "Auto Repair",
        description: "Automotive repair and maintenance",
      },
      {
        slug: "car-dealerships",
        name: "Car Dealerships",
        description: "New and used car dealerships",
      },
      {
        slug: "car-rentals",
        name: "Car Rentals",
        description: "Car rental and vehicle hire",
      },
      {
        slug: "engine-repair-garages",
        name: "Engine Repair Garages",
      },
      {
        slug: "fleet-vehicle-leasing-services",
        name: "Fleet & Vehicle Leasing Services",
        description:
          "Commercial fleet management and vehicle tracking services",
      },
      {
        slug: "panel-beaters",
        name: "Panel Beaters",
        description: "Panel beating and collision repair",
      },
      {
        slug: "petrol-stations",
        name: "Petrol Stations",
      },
      {
        slug: "tyre-services",
        name: "Tyre Services",
        description: "Tyre sales and services",
      },
    ],
  },
  {
    slug: "beauty-wellness",
    name: "Beauty & Wellness",
    description: "Beauty salons, spas, wellness centers, and personal care",
    verticals: [
      {
        slug: "beauty-cosmetics-retail",
        name: "Beauty & Cosmetics Retail",
        description:
          "South Africa's cosmetics retail market is valued at USD 2.94-3.97 billion (2025) with projected growth to USD 5.29 billion by 2030. Dominated by pharmacy retailers Clicks and Dis-Chem. Supermarkets and hypermarkets hold 40.34% market share, while specialty beauty stores are the fastest-growing channel at 8.21% CAGR. Online retail at 12.5% of sales with 8.34% projected growth.",
      },
      {
        slug: "beauty-training-academies",
        name: "Beauty Training & Academies",
        description:
          "South Africa's beauty education sector is regulated by Services SETA and offers pathways to careers in hairdressing, beauty therapy, nail technology, and aesthetic treatments. Key accredited institutions include Hydro International College, The Beauty Hub Academy, Face to Face Beauty School, Blush Academy, and Beautique Academy. Qualifications are recognized by Services SETA, QCTO, and international bodies like ITEC and CIDESCO. The sector serves both aspiring professionals and existing practitioners seeking upskilling, addressing significant skills gaps in the industry.",
      },
      {
        slug: "fitness-centers-gyms",
        name: "Fitness Centers & Gyms",
        description:
          "South Africa's fitness market generated approximately USD 400 million in 2022, projected to reach USD 600 million by 2030. Dominated by Virgin Active (60-70% market share, 137 branches) and Planet Fitness (50+ gyms, expanding 5 annually). The sector includes premium chains, budget gyms like Just Gym (R200-300/month), boutique studios, and CrossFit boxes. Gym fees increased 20.5% year-over-year through 2025.",
      },
      {
        slug: "hair-salons-barbershops",
        name: "Hair Salons & Barbershops",
        description: "Hair salons and barbershops",
      },
      {
        slug: "makeup-studios",
        name: "Makeup Studios",
        description: "Professional makeup artists and studios",
      },
      {
        slug: "massage-therapy-centers",
        name: "Massage Therapy Centers",
        description: "Massage therapy and bodywork centers",
      },
      {
        slug: "medical-aesthetics-cosmetic-surgery",
        name: "Medical Aesthetics & Cosmetic Surgery",
        description: "Plastic surgery and cosmetic procedure clinics",
      },
      {
        slug: "mobile-beauty-services",
        name: "Mobile Beauty Services",
        description:
          "Mobile beauty services represent a growing segment in South Africa, offering convenient at-home or on-location services including haircuts, nail treatments, makeup, and facials. The sector is driven by time-poor urban professionals and enabled by booking apps and social media marketing. Operators range from individual freelancers to organized mobile service platforms. The model benefits from low overhead costs but faces challenges in pricing, logistics, and establishing trust. Mobile services gained significant traction post-pandemic as clients sought safer, more convenient options.",
      },
      {
        slug: "nail-salons-beauty-bars",
        name: "Nail Salons & Beauty Bars",
        description: "Nail salons and nail bars",
      },
      {
        slug: "personal-care-product-manufacturing",
        name: "Personal Care Product Manufacturing",
        description:
          "South Africa's personal care manufacturing sector is valued at approximately R20 billion at manufacturing level (R27 billion at retail), making it the largest in Africa. The industry includes multinational manufacturing (Unilever, P&G), local brand owners (Tiger Brands, Indigo Brands, Annique), contract manufacturers (Brunational, Alchem Labs, Customised Cosmetics, AIC), and SME/cottage industry producers.",
      },
      {
        slug: "skincare-aesthetics-clinics",
        name: "Skincare & Aesthetics Clinics",
        description:
          "South Africa's skincare products market is expected to reach USD 0.83 billion in 2025, growing at 7.06% CAGR. The aesthetic devices market is projected to reach USD 102.97 million in 2025, growing at 11.51% CAGR to USD 177.53 million by 2030. Leading clinic chains include Skin Renewal (20 clinics across 3 provinces), Laserderm, Natural Aesthetics, and Body360. The sector bridges medical and beauty services, with strict HPCSA regulations governing injectable treatments.",
      },
      {
        slug: "spas-wellness-centers",
        name: "Spas & Wellness Centers",
        description:
          "South Africa's spa market is projected to grow by USD 700 million from 2024-2029, with the broader Africa wellness tourism market expected to reach USD 94.04 billion by 2025. The sector ranges from luxury destination spas at safari lodges to urban day spas and township wellness centers. Key players include Africology, Mangwanani, Camelot Spa, and spa facilities at major hotel groups.",
      },
      {
        slug: "tanning-salons",
        name: "Tanning Salons",
        description: "Tanning and spray tan salons",
      },
    ],
  },
  {
    slug: "insurance",
    name: "Insurance",
    description: "Insurance companies, brokers, and risk management services",
    verticals: [
      {
        slug: "claims-management-administration",
        name: "Claims Management & Administration",
        description:
          "Claims management, administration, and third-party administration (TPA) services in South Africa for life and non-life insurers. Market driven by efficiency demands, fraud detection, customer experience expectations, and climate-related claims surges. Key challenges: load shedding claims, motor theft, and weather events.",
      },
      {
        slug: "commercial-specialty-insurance",
        name: "Commercial & Specialty Insurance",
        description:
          "Commercial and specialty insurance in South Africa including D&O liability, professional indemnity, cyber insurance, marine, aviation, and engineering. Market driven by corporate governance requirements, cyber threat escalation, and specialized risk expertise. Key players: AIG, Chubb, Allianz, Zurich, local specialists.",
      },
      {
        slug: "funeral-insurance",
        name: "Funeral Insurance",
        description: "Funeral cover and burial insurance providers",
      },
      {
        slug: "health-insurance-medical-schemes",
        name: "Health Insurance & Medical Schemes",
      },
      {
        slug: "insurance-brokers-intermediaries",
        name: "Insurance Brokers & Intermediaries",
        description:
          "Insurance brokers, agents, and intermediaries in South Africa. Brokers handle ~45% of P&C insurance, agents ~20%, banks/direct ~35%. Market with 1000+ licensed brokers and 5000+ agents. Key players: Santam, Hollard, Zurich SA. FAIS Act primary regulatory framework. Digital disruption threatening traditional commission models.",
      },
      {
        slug: "insurance-technology-insurtech",
        name: "Insurance Technology (InsurTech)",
        description: "Digital insurance platforms and technology solutions",
      },
      {
        slug: "life-insurance",
        name: "Life Insurance",
        description: "Life insurance providers",
      },
      {
        slug: "reinsurance",
        name: "Reinsurance",
        description: "Insurance providers for insurance companies",
      },
      {
        slug: "risk-management-actuarial-services",
        name: "Risk Management & Actuarial Services",
        description:
          "Professional actuarial consulting, risk modeling, valuation, and strategic advisory to insurers and pension funds in South Africa. Market with 500+ qualified actuaries. Key players: Insight Life Solutions, Directrix, QED Actuaries, Big 4 (PwC, EY, KPMG, Deloitte). IFRS 17 Feb 2025 deadline major demand driver. ASSA (Actuarial Society of SA) oversight.",
      },
      {
        slug: "short-term-insurance",
        name: "Short-Term Insurance",
        description: "Short-term and general insurance",
      },
      {
        slug: "vehicle-insurance",
        name: "Vehicle Insurance",
        description: "Auto and vehicle insurance providers",
      },
    ],
  },
  {
    slug: "marketing-advertising",
    name: "Marketing & Advertising",
    description: "Marketing agencies, advertising, and branding services",
    verticals: [
      {
        slug: "brand-strategy-consulting",
        name: "Brand Strategy & Consulting",
        description:
          "South Africa brand strategy and consulting market within ICT consulting projected at $49B+ by 2028 (6% CAGR). 92% of enterprises increased budgets in 2024. Services include brand positioning, market research, transformation execution, competitive intelligence, and go-to-market strategy with SA-specific expertise in B-BBEE, load shedding, and language diversity.",
      },
      {
        slug: "content-marketing-seo",
        name: "Content Marketing & SEO",
        description:
          "Content creation, copywriting, and content strategy services",
      },
      {
        slug: "digital-marketing",
        name: "Digital Marketing",
        description: "Digital marketing and online advertising",
      },
      {
        slug: "event-marketing",
        name: "Event Marketing",
        description: "Event planning, trade shows, and experiential marketing",
      },
      {
        slug: "graphic-design",
        name: "Graphic Design",
        description: "Graphic design and branding",
      },
      {
        slug: "influencer-marketing",
        name: "Influencer Marketing",
        description:
          "South Africa influencer advertising market projected at $44.28M by 2029 (10.29% CAGR 2024-2029). Microinfluencer ROI averages 600% (R6 per R1 spent). Services include creator discovery, fraud detection, campaign management, and ROI attribution. Growing focus on authenticity, ARB Code compliance, and long-tail creator relationships.",
      },
      {
        slug: "market-research-analytics",
        name: "Market Research & Analytics",
        description:
          "South Africa data analytics market projected at $2,758.9M by 2030 (17.3% CAGR 2025-2030). Enterprise ICT budgets up 92% in 2024. Services include consumer research, competitive intelligence, brand tracking, market sizing, and advanced analytics. Growing focus on AI/ML capabilities, real-time dashboards, and SA-specific data quality solutions.",
      },
      {
        slug: "marketing-automation",
        name: "Marketing Automation",
        description: "Marketing technology and automation platforms",
      },
      {
        slug: "marketing-technology-martech",
        name: "Marketing Technology (MarTech)",
        description:
          "Global MarTech market projected at $215B+ by 2027 (13.3% CAGR). South Africa enterprise ICT budgets up 92% in 2024. Solutions include marketing automation, CRM, CDP, analytics, email platforms, and personalization tools. Key focus on POPIA compliance, integration complexity, and cost optimization.",
      },
      {
        slug: "out-of-home-ooh-advertising",
        name: "Out-of-Home (OOH) Advertising",
        description:
          "South Africa OOH and DOOH market valued at $249.94M in 2025, projected $293.70M by 2030 (3.28% CAGR). DOOH growing 7.4% annually. Services include billboard advertising, digital screens, transit advertising, and programmatic DOOH. Load shedding impact down 82% in 2025. Key focus on measurement, programmatic buying, and omnichannel integration.",
      },
      {
        slug: "public-relations-communications",
        name: "Public Relations & Communications",
        description: "Public relations and communications",
      },
      {
        slug: "seo-sem-agencies",
        name: "SEO/SEM Agencies",
        description: "Search engine optimization and search engine marketing",
      },
      {
        slug: "social-media-marketing",
        name: "Social Media Marketing",
        description: "Social media management and influencer marketing",
      },
      {
        slug: "traditional-advertising-agencies",
        name: "Traditional Advertising Agencies",
        description:
          "Full-service agencies providing TV, radio, print, and outdoor advertising services including media planning, media buying, and creative production. TV & Video advertising largest segment ($742.65M in 2025), but digital expected to reach 74% of total ad spend by 2029. Major cities: Johannesburg (advertising capital), Cape Town, Durban.",
      },
      {
        slug: "video-production",
        name: "Video Production",
        description: "Video and film production",
      },
    ],
  },
  {
    slug: "human-resources",
    name: "Human Resources",
    description: "HR services, staffing agencies, and recruitment firms",
    verticals: [
      {
        slug: "compensation-rewards-consulting",
        name: "Compensation & Rewards Consulting",
        description:
          "Salary benchmarking, incentive design, and total rewards strategy",
      },
      {
        slug: "employee-engagement-culture",
        name: "Employee Engagement & Culture",
        description:
          "Employee satisfaction, culture consulting, and engagement platforms",
      },
      {
        slug: "employee-wellness-eap",
        name: "Employee Wellness & EAP",
        description:
          "Employee Assistance Programs and corporate wellness services addressing mental health, lifestyle, and workplace wellbeing. Key providers include ICAS, Careways, and Company Wellness Solutions. Market estimated at R1-2 billion with growing demand driven by workplace stress (40%+ of workforce affected), mental health awareness, and productivity concerns.",
      },
      {
        slug: "employer-branding-talent-marketing",
        name: "Employer Branding & Talent Marketing",
        description:
          "Recruitment marketing, employer brand strategy, and candidate experience",
      },
      {
        slug: "hr-consulting-compliance",
        name: "HR Consulting & Compliance",
        description:
          "Labor law compliance, HR policy development, and regulatory advisory",
      },
      {
        slug: "labour-relations-ir-consulting",
        name: "Labour Relations & IR Consulting",
        description:
          "Industrial relations advisory services including CCMA representation, union negotiations, disciplinary hearings, and retrenchment consulting. Key players include Chamlabour, Cape Labour, and The GEO. Market driven by high CCMA case volumes (~190,000 annually), union activity, and complex SA labour legislation requiring specialist expertise.",
      },
      {
        slug: "payroll-benefits-administration",
        name: "Payroll & Benefits Administration",
        description:
          "Outsourced payroll processing, benefits administration, and related compliance services. Market led by Sage Payroll, PaySpace, and specialist providers like CRS and Payroll Hub. Strong growth in cloud-based solutions with market estimated at R2-4 billion. High demand driven by compliance complexity around UIF, PAYE, SDL, and COIDA.",
      },
      {
        slug: "performance-management-solutions",
        name: "Performance Management Solutions",
        description:
          "Performance review systems, goal tracking, and talent analytics",
      },
      {
        slug: "permanent-recruitment-agencies",
        name: "Permanent Recruitment Agencies",
        description:
          "Specialized agencies placing permanent employees across all levels and sectors. Market dominated by Quest Staffing, Communicate Personnel, and specialist IT recruiters like OfferZen. Industry facing pressure from AI-driven platforms and in-house recruitment teams. Estimated R5-8 billion market with fees typically 15-20% of annual salary.",
      },
      {
        slug: "temporary-staffing-agencies-tes",
        name: "Temporary Staffing Agencies (TES)",
        description:
          "Labour brokers and Temporary Employment Services (TES) providing flexible workforce solutions across sectors. The market is heavily regulated under Section 198 of the LRA with the three-month deeming provision. Major players include Adcorp, MASA Outsourcing, and Quest Staffing. Market estimated at R15-20 billion, with manufacturing, retail, and logistics driving demand.",
      },
      {
        slug: "background-screening-verification",
        name: "Background Screening & Verification",
        description: "Employee verification and screening services",
      },
      {
        slug: "benefits-administration",
        name: "Benefits Administration",
        description: "Employee benefits management and administration",
      },
      {
        slug: "executive-search",
        name: "Executive Search",
        description: "Senior-level recruitment and headhunting",
      },
      {
        slug: "hr-technology-hris-hcm",
        name: "HR Technology (HRIS/HCM)",
        description: "HR software and technology solutions",
      },
      {
        slug: "outplacement-services",
        name: "Outplacement Services",
        description: "Career transition and outplacement support",
      },
      {
        slug: "recruitment-agencies",
        name: "Recruitment Agencies",
        description: "Professional and permanent placement services",
      },
      {
        slug: "training-development",
        name: "Training & Development",
        description: "Corporate training and skills development",
      },
      {
        slug: "workforce-management",
        name: "Workforce Management",
        description: "Workforce planning and management solutions",
      },
    ],
  },
];
