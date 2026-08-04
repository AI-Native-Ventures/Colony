import type { BusinessTaxonomyIndustry } from "./types";

export const BUSINESS_TAXONOMY_PART_3: readonly BusinessTaxonomyIndustry[] = [
  {
    slug: "transportation",
    name: "Transportation",
    description: "Transportation, logistics, and shipping services",
    verticals: [
      {
        slug: "3pl-4pl-providers",
        name: "3PL/4PL Providers",
        description:
          "Third-party and fourth-party logistics outsourcing services",
      },
      {
        slug: "cold-chain-logistics",
        name: "Cold Chain Logistics",
      },
      {
        slug: "cross-border-logistics",
        name: "Cross-Border Logistics",
        description: "International shipping and customs clearance services",
      },
      {
        slug: "fleet-management",
        name: "Fleet Management",
      },
      {
        slug: "port-terminal-operations",
        name: "Port & Terminal Operations",
        description:
          "Container terminals, port logistics, and intermodal facilities",
      },
      {
        slug: "public-transport-operators",
        name: "Public Transport Operators",
      },
      {
        slug: "specialized-transport",
        name: "Specialized Transport",
        description:
          "Hazardous materials, oversized cargo, and specialized freight services",
      },
      {
        slug: "air-cargo",
        name: "Air Cargo",
        description: "Air freight and cargo services",
      },
      {
        slug: "bus-services",
        name: "Bus Services",
        description: "Passenger bus transportation",
      },
      {
        slug: "last-mile-courier-services",
        name: "Last Mile & Courier Services",
        description: "Package delivery and courier services",
      },
      {
        slug: "freight-trucking",
        name: "Freight Trucking",
        description: "Road freight and trucking services",
      },
      {
        slug: "logistics-warehousing",
        name: "Logistics & Warehousing",
        description: "Warehousing and supply chain services",
      },
      {
        slug: "maritime-shipping",
        name: "Maritime Shipping",
        description: "Ocean freight and shipping services",
      },
      {
        slug: "moving-companies",
        name: "Moving Companies",
        description: "Residential and commercial moving services",
      },
      {
        slug: "rail-transport",
        name: "Rail Transport",
        description: "Rail freight and passenger services",
      },
      {
        slug: "taxi-rideshare",
        name: "Taxi & Rideshare",
        description: "Taxi and ride-hailing services",
      },
      {
        slug: "vehicle-leasing",
        name: "Vehicle Leasing",
        description: "Fleet and vehicle leasing services",
      },
    ],
  },
  {
    slug: "agriculture",
    name: "Agriculture",
    description: "Agricultural businesses, farming, and agribusiness",
    verticals: [
      {
        slug: "agri-coops-suppliers",
        name: "Agri-Coops & Suppliers",
      },
      {
        slug: "agricultural-processing",
        name: "Agricultural Processing",
        description:
          "Post-harvest processing facilities including grain elevators, packing houses, and food processing plants",
      },
      {
        slug: "agritech-companies",
        name: "Agritech Companies",
      },
      {
        slug: "animal-feed-nutrition",
        name: "Animal Feed & Nutrition",
        description:
          "Manufacturers of livestock feed, supplements, and animal nutrition products",
      },
      {
        slug: "commercial-farms",
        name: "Commercial Farms",
      },
      {
        slug: "fertilizer-agrochemicals",
        name: "Fertilizer & Agrochemicals",
        description:
          "Manufacturers and distributors of fertilizers, pesticides, herbicides, and crop protection products",
      },
      {
        slug: "irrigation-systems",
        name: "Irrigation Systems",
        description:
          "Providers of irrigation equipment, water management systems, and precision watering solutions",
      },
      {
        slug: "seed-companies",
        name: "Seed Companies",
        description:
          "Producers and distributors of commercial seeds, hybrid varieties, and genetic material",
      },
      {
        slug: "agricultural-equipment",
        name: "Agricultural Equipment",
        description:
          "Companies selling and servicing farm machinery and equipment",
      },
      {
        slug: "aquaculture-fishing",
        name: "Aquaculture & Fishing",
        description: "Fish farming and commercial fishing operations",
      },
      {
        slug: "crop-farming",
        name: "Crop Farming",
        description: "Agricultural operations focused on growing crops",
      },
      {
        slug: "dairy-farming",
        name: "Dairy Farming",
        description: "Milk and dairy product production operations",
      },
      {
        slug: "forestry-logging",
        name: "Forestry & Logging",
        description: "Timber production and forest management",
      },
      {
        slug: "livestock-farming",
        name: "Livestock Farming",
        description: "Animal husbandry and meat production",
      },
      {
        slug: "nurseries-greenhouses",
        name: "Nurseries & Greenhouses",
        description: "Plant cultivation and garden center operations",
      },
      {
        slug: "poultry-farming",
        name: "Poultry Farming",
        description: "Chicken, turkey, and egg production operations",
      },
      {
        slug: "pet-stores",
        name: "Pet Stores",
        description: "Pet supplies and services retail",
      },
      {
        slug: "vineyards-wineries",
        name: "Vineyards & Wineries",
        description: "Grape growing and wine production",
      },
    ],
  },
  {
    slug: "energy",
    name: "Energy",
    description: "Energy companies, utilities, and renewable energy providers",
    verticals: [
      {
        slug: "bioenergy-biomass",
        name: "Bioenergy & Biomass",
        description: "Biofuel production and biomass energy generation",
      },
      {
        slug: "coal-power-plants-decommissioning",
        name: "Coal Power Plants & Decommissioning",
        description:
          "South Africa's 15 coal-fired power stations (36 GW capacity) provide 80% of electricity but face accelerated phase-out. IRP 2025 mandates 9.6 GW closure by 2035. Major challenges: reliability (60% EAF), Just-Transition requirements, repurposing sites, and managing workforce transition. Decommissioning market emerging as R50B+ opportunity.",
      },
      {
        slug: "commercial-industrial-energy-solutions",
        name: "Commercial & Industrial Energy Solutions",
        description:
          "Booming sector of commercial and industrial (C&I) companies adopting solar, storage, and efficiency solutions. Industry is now largest solar adopter with 4 GW installed capacity. Payback periods 2-3 years driving strong demand. Solutions include rooftop solar, energy storage, demand-side management (DSM), EV charging, and efficiency retrofits. Market growing 20%+ annually.",
      },
      {
        slug: "energy-consulting-services",
        name: "Energy Consulting & Services",
        description:
          "Rapidly growing consulting sector supporting energy transition. Services include feasibility studies, environmental assessments, NERSA approvals, grid studies, project development, and technical due diligence. Market driven by accelerating renewable capacity additions, DSO model adoption, and just-transition requirements. Demand for specialized expertise in grid integration, SCADA systems, and regulatory navigation.",
      },
      {
        slug: "energy-storage-systems",
        name: "Energy Storage Systems",
        description:
          "South Africa's BESS market is rapidly expanding with 1.4 GW capacity in 2023 growing to projected 2+ GW by 2026. IRP 2025 targets significant storage capacity. REIPPPP Bid Window 6 procured 500 MW BESS. Market driven by grid stability needs, renewable integration, and load-shedding mitigation. C&I storage adoption accelerating with 2-3 year payback economics.",
      },
      {
        slug: "grid-infrastructure-transmission",
        name: "Grid Infrastructure & Transmission",
        description:
          "Eskom's transmission assets separated into National Transmission Company South Africa (NTCSA) in 2024. Critical focus: grid upgrades to enable renewable integration, grid stabilization infrastructure, and regional interconnects. 6,000+ MW renewable capacity additions require massive transmission investment (R50B+). Congestion curtailment framework (NERSA approved Apr 2025) provides temporary relief but long-term expansion essential.",
      },
      {
        slug: "hydroelectric-power",
        name: "Hydroelectric Power",
        description: "Hydropower generation and dam operations",
      },
      {
        slug: "just-energy-transition-workforce-development",
        name: "Just Energy Transition & Workforce Development",
        description:
          "Critical focus area supporting coal power phase-out and energy transition. Includes workforce retraining programs, community economic development, skills development, and social mitigation. Government Just-Transition Investment Program (JET-IP) allocating R131B. Major opportunity in skills training, vocational programs, and alternative employment generation in coal-dependent regions.",
      },
      {
        slug: "natural-gas-lng",
        name: "Natural Gas & LNG",
        description:
          "South Africa pursuing natural gas as transition fuel under IRP 2025 with 3,000 MW gas allocation. LNG import terminals under development (Richards Bay, Coega). ROMPCO pipeline from Mozambique supplies existing gas plants. Upstream Petroleum Bill pending. Market emerging with R30-50B investment pipeline for gas infrastructure and power plants.",
      },
      {
        slug: "nuclear-energy",
        name: "Nuclear Energy",
        description: "Nuclear power generation and related services",
      },
      {
        slug: "vehicle-to-grid-v2g-ev-charging-infrastructure",
        name: "Vehicle-to-Grid (V2G) & EV Charging Infrastructure",
        description:
          "Emerging sector supporting electric vehicle (EV) transition and grid stability. V2G technology enables EV batteries to support grid (bidirectional charging). Charging infrastructure rapidly expanding with corporate EV adoption. Opportunities: public charging networks, workplace charging, fleet management, grid integration. Government pushing EV uptake (tax incentives, manufacturing support). Market emerging but explosive growth potential.",
      },
      {
        slug: "coal-mining",
        name: "Coal Mining",
        description: "Coal extraction and processing operations",
      },
      {
        slug: "electric-utilities-distribution",
        name: "Electric Utilities & Distribution",
        description: "Electricity generation and distribution companies",
      },
      {
        slug: "energy-equipment-manufacturing",
        name: "Energy Equipment & Manufacturing",
        description: "Manufacturers and suppliers of energy equipment",
      },
      {
        slug: "gas-utilities",
        name: "Gas Utilities",
        description: "Natural gas distribution companies",
      },
      {
        slug: "oil-gas",
        name: "Oil & Gas",
        description: "Upstream oil and gas exploration and production",
      },
      {
        slug: "power-generation",
        name: "Power Generation",
        description: "Independent power producers and generation facilities",
      },
      {
        slug: "renewable-energy",
        name: "Renewable Energy",
        description: "Clean energy development and operations",
      },
      {
        slug: "solar-energy",
        name: "Solar Energy",
        description: "Solar panel installation and maintenance services",
      },
      {
        slug: "wind-energy",
        name: "Wind Energy",
        description: "Wind farm development and operations",
      },
    ],
  },
  {
    slug: "telecommunications",
    name: "Telecommunications",
    description: "Telecommunications providers and communication services",
    verticals: [
      {
        slug: "5g-network-services",
        name: "5G Network Services",
        description: "Next-generation mobile network technology and solutions",
      },
      {
        slug: "cloud-communications-ucaas",
        name: "Cloud Communications & UCaaS",
        description: "Cloud-based communication platforms (UCaaS, CCaaS)",
      },
      {
        slug: "data-centers-colocation",
        name: "Data Centers & Colocation",
        description:
          "Facilities providing server hosting, colocation, and cloud infrastructure services. South Africa market: 69 operational data centers (mostly Tier III standards), projected to grow to USD 843M by 2030 (12.76% CAGR). Major players: Teraco (Digital Realty), Vantage Data Centers, OADC, Digital Parks Africa, AWS, Microsoft Azure.",
      },
      {
        slug: "enterprise-connectivity-sd-wan",
        name: "Enterprise Connectivity & SD-WAN",
        description:
          "Providers delivering managed SD-WAN, MPLS replacement, and enterprise connectivity solutions to corporate and institutional customers. Market growing 3.84% CAGR with major players including Logicalis, Cisco, Verizon, and local operators (Telkom, Vodacom Business, MTN). Solutions bundling DIA (Dedicated Internet Access), SASE, SSE for security.",
      },
      {
        slug: "iot-connectivity",
        name: "IoT Connectivity",
        description: "Internet of Things network connectivity and platforms",
      },
      {
        slug: "managed-network-services",
        name: "Managed Network Services",
        description: "Outsourced network management and monitoring",
      },
      {
        slug: "satellite-communications-remote-connectivity",
        name: "Satellite Communications & Remote Connectivity",
        description:
          "Providers offering VSAT (Very Small Aperture Terminal), satellite backhaul, and remote connectivity solutions. Market serves oil/gas, mining, maritime, aviation, and rural telecom customers. Major providers: Hughes, GlobalTT, Telkom SA (SPACESTREAM), SEACOM, NTvsat. Growing demand for last-mile rural connectivity and disaster recovery.",
      },
      {
        slug: "telecom-consulting",
        name: "Telecom Consulting",
        description:
          "Strategic consulting for telecommunications infrastructure",
      },
      {
        slug: "wireless-isps-fixed-wireless-access",
        name: "Wireless ISPs & Fixed Wireless Access",
        description:
          "Operators providing high-speed broadband using wireless technologies (LTE, 4G, 5G) as alternative to fixed fiber. Major players: Rain (most aggressive), Vodacom AirFibre (MTN subsidiary Supersonic), emerging operators using 700MHz. Market growing rapidly with FWA accessible to 78.9% of SA population in 2025.",
      },
      {
        slug: "cable-satellite",
        name: "Cable & Satellite",
        description: "Cable TV and satellite service providers",
      },
      {
        slug: "fiber-network-operators",
        name: "Fiber Network Operators",
        description: "Fiber optic network installation and services",
      },
      {
        slug: "internet-service-providers",
        name: "Internet Service Providers",
        description: "Internet connectivity services",
      },
      {
        slug: "mobile-network-operators",
        name: "Mobile Network Operators",
        description: "Mobile network operators and carriers",
      },
      {
        slug: "network-infrastructure",
        name: "Network Infrastructure",
        description: "Network equipment and infrastructure providers",
      },
      {
        slug: "telecom-equipment-infrastructure",
        name: "Telecom Equipment & Infrastructure",
        description: "Telecommunications equipment sales and service",
      },
      {
        slug: "tower-passive-infrastructure",
        name: "Tower & Passive Infrastructure",
        description: "Cell tower and infrastructure companies",
      },
      {
        slug: "voip-services",
        name: "VoIP Services",
        description: "Voice over IP telephone services",
      },
    ],
  },
  {
    slug: "media-entertainment",
    name: "Media & Entertainment",
    description: "Media companies, entertainment, and content creators",
    verticals: [
      {
        slug: "advertising-creative-services",
        name: "Advertising & Creative Services",
        description:
          "Creative advertising agencies, commercial production, and marketing content studios",
      },
      {
        slug: "animation-visual-effects",
        name: "Animation & Visual Effects",
        description: "Animation studios, VFX production, and CGI services",
      },
      {
        slug: "bookstores-media-retailers",
        name: "Bookstores & Media Retailers",
        description: "Book retailers, music stores, and media product shops",
      },
      {
        slug: "digital-content-media",
        name: "Digital Content & Media",
        description:
          "South African influencers, content creators, YouTubers, TikTokers, and digital-first media platforms. Ecosystem includes 79,528 Instagram influencers (up to 500k followers), 500,000+ trained creators via theSalt, with 33.6% of social media users following influencers. Micro-influencer ROI averaging 600% (R6 per R1 spent). Creator economy growing rapidly with emerging platforms and direct sponsorship models.",
      },
      {
        slug: "film-video-production",
        name: "Film & Video Production",
        description:
          "South African film and video production industry serving international productions, local content creation, and streaming platforms. Market experiencing 50% contraction due to film rebate system delays, load shedding disruption, and streaming plateau. Gauteng and Western Cape are primary production hubs with €250M+ foreign investment (2023-2025).",
      },
      {
        slug: "live-events-entertainment",
        name: "Live Events & Entertainment",
        description:
          "South African event management, live entertainment, and conference industry. Market growing with Cape Town ranked top African convention city and highest-ranked conference destination in Africa/Middle East. Major drivers include G20 summit hosting, 2027 Cricket World Cup co-hosting, Formula 1 aspirations, and destination festivals. Challenges include crime, visa processing delays, and load shedding impact on event reliability.",
      },
      {
        slug: "music-industry",
        name: "Music Industry",
        description:
          "South African music recording, publishing, live events, and streaming sector. Includes major record labels, independent artists, concert promotion companies, and streaming platform partnerships. Industry experiencing growth through streaming adoption, international festival presence (Jerk x Jollof in Cape Town), and SAMA awards ecosystem. 31st SAMA31 broadcast on YouTube and SABC1.",
      },
      {
        slug: "podcasting-audio-content",
        name: "Podcasting & Audio Content",
        description:
          "Podcast production, audio content creation, and distribution platforms",
      },
      {
        slug: "print-media",
        name: "Print Media",
        description:
          "Newspapers, magazines, and print publications facing severe decline in South Africa. Print media is the only E&M segment forecast to shrink through 2028. Newspaper circulation dropped 17% year-on-year (Q2 2024). Major closures include Beeld, Rapport, City Press, Daily Sun. Limited success stories include Zululand Observer (24% growth) and TFG Club magazine (286,000 editions). Hybrid models combining targeted print with digital-first strategy showing promise.",
      },
      {
        slug: "theater-performing-arts",
        name: "Theater & Performing Arts",
        description:
          "Live theater companies, dance troupes, performance venues, and performing arts centers",
      },
      {
        slug: "gaming-esports",
        name: "Gaming & Esports",
        description: "Video game development and esports organizations",
      },
      {
        slug: "music-production",
        name: "Music Production",
        description: "Music recording, production, and labels",
      },
      {
        slug: "news-media",
        name: "News Media",
        description: "News organizations and journalism",
      },
      {
        slug: "publishing",
        name: "Publishing",
        description: "Book, magazine, and digital publishing",
      },
      {
        slug: "radio-broadcasting",
        name: "Radio Broadcasting",
        description: "Radio stations and audio broadcasting",
      },
      {
        slug: "sports-management",
        name: "Sports Management",
        description: "Sports teams, leagues, and athlete management",
      },
      {
        slug: "streaming-services",
        name: "Streaming Services",
        description: "Digital streaming platforms and services",
      },
      {
        slug: "television-broadcasting",
        name: "Television Broadcasting",
        description: "TV stations and broadcast networks",
      },
    ],
  },
  {
    slug: "food-beverage",
    name: "Food & Beverage",
    description: "Food service, restaurants, catering, and beverage companies",
    verticals: [
      {
        slug: "agricultural-processing-value-add",
        name: "Agricultural Processing & Value-Add",
        description:
          "Agricultural processing and value-added production in South Africa including grain milling, fruit and vegetable processing, meat processing, and dairy. Links primary agriculture to food manufacturing. Challenges: raw material cost volatility, energy crisis, water constraints, and export market compliance.",
      },
      {
        slug: "alcoholic-beverages-manufacturing",
        name: "Alcoholic Beverages Manufacturing",
        description:
          "Alcoholic beverage manufacturing in South Africa with 52.91% of beverage market share. Market facing 6.75% excise duty increase (2025), progressive rates under consideration. Excise manufacturing warehouse (VM) registration mandatory. Key players: SAB (AB InBev), Distell, Heineken. Consumer moderation trends and craft beverage growth reshaping market.",
      },
      {
        slug: "bars-nightclubs",
        name: "Bars & Nightclubs",
        description: "Bars, pubs, lounges, and nightclub establishments",
      },
      {
        slug: "cafes-coffee-shops",
        name: "Cafes & Coffee Shops",
        description: "Coffee shops, cafes, and tea houses",
      },
      {
        slug: "catering-services",
        name: "Catering Services",
        description: "Event catering and food service providers",
      },
      {
        slug: "food-manufacturing-processing",
        name: "Food Manufacturing & Processing",
        description:
          "Food manufacturing in South Africa with $19.8B market (2025) growing 5.06% CAGR. Market challenged by energy costs (450%+ increase from load shedding), 12.7% tariff increases, and Health Promotion Levy. Key players: Tiger Brands, Pioneer Foods, RCL Foods. NRCS food safety compliance mandatory. B-BBEE transformation required.",
      },
      {
        slug: "food-packaging-manufacturing",
        name: "Food Packaging Manufacturing",
        description:
          "Food packaging manufacturing in South Africa serving food and beverage producers. Market driven by Extended Producer Responsibility (EPR) with 8% recycled content mandate, sustainable packaging demand, and retailer requirements. Challenges: raw material costs, recycled content sourcing, energy costs, and design innovation pressure.",
      },
      {
        slug: "food-retail-supermarkets",
        name: "Food Retail & Supermarkets",
        description:
          "Food retail and supermarkets in South Africa with $42.69B forecast by 2029, growing 7.25% CAGR. Market led by Shoprite, Pick n Pay, Woolworths, SPAR. Independent wholesalers (Devland, Elite Star) gaining ground. Challenges: competition law scrutiny, cold chain breakdowns, e-commerce pressure, rising food prices 8-15% YoY.",
      },
      {
        slug: "food-safety-quality-testing",
        name: "Food Safety & Quality Testing",
        description:
          "Food safety testing, quality assurance, and certification services in South Africa. Market driven by NRCS compliance requirements, export certification, retailer audit demands, and consumer safety expectations. Key players: SGS, Intertek, Eurofins, SANAS-accredited labs. Growing demand for traceability and contaminant testing.",
      },
      {
        slug: "full-service-restaurants-casual-dining",
        name: "Full Service Restaurants & Casual Dining",
        description:
          "Full service and casual dining restaurants in South Africa, second largest foodservice segment. Market driven by experience-focused dining, premiumization, and delivery integration. Key players: Spur, Ocean Basket, Hussar Grill, Tasha's. Challenges: labor costs, energy crisis, consumer discretionary spending pressure, delivery economics.",
      },
      {
        slug: "non-alcoholic-beverage-manufacturing",
        name: "Non-Alcoholic Beverage Manufacturing",
        description:
          "Non-alcoholic beverage manufacturing in South Africa with 47.09% market share, growing 6.84% CAGR (outpacing alcoholic). Market reaching $25.34B by 2030. Key segments: sugar-free energy drinks, RTD teas, plant-based milks, functional beverages. Health Promotion Levy driving reformulation. >50% of products require warning labels.",
      },
      {
        slug: "quick-service-restaurants-qsr",
        name: "Quick Service Restaurants (QSR)",
        description:
          "Quick service restaurants (fast food) in South Africa with 39.22% of $10.16B foodservice market, growing 8.4% CAGR to $20.11B by 2030. Approximately 5,982 restaurants. Key players: KFC, McDonald's, Nando's, Pedros. Top 15 brands control 80%. Chicken Wars dominating competitive landscape. 9 of top 10 QSRs showing declining foot traffic despite growth.",
      },
      {
        slug: "specialty-food-beverage",
        name: "Specialty Food & Beverage",
        description:
          "Specialty food stores, wine shops, gourmet retailers, and organic food markets",
      },
      {
        slug: "bakeries",
        name: "Bakeries",
        description: "Bread, pastry, and baked goods production",
      },
      {
        slug: "beverage-distribution",
        name: "Beverage Distribution",
        description: "Wholesale distribution of beverages",
      },
      {
        slug: "convenience-stores",
        name: "Convenience Stores",
        description: "Small-format convenience retail",
      },
      {
        slug: "beverage-manufacturing",
        name: "Beverage Manufacturing",
        description: "Production of soft drinks and beverages",
      },
      {
        slug: "breweries-distilleries",
        name: "Breweries & Distilleries",
        description: "Beer, spirits, and alcoholic beverage production",
      },
      {
        slug: "butcheries",
        name: "Butcheries",
        description: "Meat processing and retail operations",
      },
      {
        slug: "coffee-roasters",
        name: "Coffee Roasters",
        description: "Coffee roasting and specialty coffee production",
      },
      {
        slug: "delis-specialty-foods",
        name: "Delis & Specialty Foods",
        description: "Specialty food shops and delicatessens",
      },
      {
        slug: "grocery-stores",
        name: "Grocery Stores",
        description: "Food and grocery retail",
      },
      {
        slug: "food-distribution-wholesale",
        name: "Food Distribution & Wholesale",
        description: "Wholesale food supply and distribution",
      },
      {
        slug: "food-trucks",
        name: "Food Trucks",
        description: "Mobile food service operations",
      },
    ],
  },
];
