export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      aircraft: {
        Row: {
          empty_weight_lb: number | null
          max_gross_lb: number | null
          fuel_capacity_lb: number | null
          limits_reported_at: string | null
          acquisition_cost: number
          base_id: string | null
          category: string
          company_id: string
          created_at: string
          cruise_kts: number
          display_name: string
          engine_type: string
          footprint: string
          fuel_burn_pph: number
          hoist: boolean
          hours: number
          id: string
          internal_id: string
          is_modded: boolean
          is_leased: boolean
          is_starter: boolean
          retired_at: string | null
          broken_down_at: string | null
          hours_at_inspection: number
          crash_damaged: boolean
          wear_before_crash: number | null
          lease_cost: number
          maintenance_factor: number
          max_range_nm: number
          notes: string | null
          op_cost_hr: number
          pax_seats: number
          payload_lbs: number
          reliability: number
          sim_title: string | null
          sim_title_aliases: string[]
          sling_load: boolean
          status: string
          tags: string[]
          wear: number
        }
        Insert: {
          empty_weight_lb?: number | null
          max_gross_lb?: number | null
          fuel_capacity_lb?: number | null
          limits_reported_at?: string | null
          acquisition_cost?: number
          base_id?: string | null
          category?: string
          company_id: string
          created_at?: string
          cruise_kts?: number
          display_name: string
          engine_type?: string
          footprint?: string
          fuel_burn_pph?: number
          hoist?: boolean
          hours?: number
          id?: string
          internal_id: string
          is_modded?: boolean
          is_leased?: boolean
          is_starter?: boolean
          retired_at?: string | null
          broken_down_at?: string | null
          hours_at_inspection?: number
          crash_damaged?: boolean
          wear_before_crash?: number | null
          lease_cost?: number
          maintenance_factor?: number
          max_range_nm?: number
          notes?: string | null
          op_cost_hr?: number
          pax_seats?: number
          payload_lbs?: number
          reliability?: number
          sim_title?: string | null
          sim_title_aliases?: string[]
          sling_load?: boolean
          status?: string
          tags?: string[]
          wear?: number
        }
        Update: {
          empty_weight_lb?: number | null
          max_gross_lb?: number | null
          fuel_capacity_lb?: number | null
          limits_reported_at?: string | null
          acquisition_cost?: number
          base_id?: string | null
          category?: string
          company_id?: string
          created_at?: string
          cruise_kts?: number
          display_name?: string
          engine_type?: string
          footprint?: string
          fuel_burn_pph?: number
          hoist?: boolean
          hours?: number
          id?: string
          internal_id?: string
          is_modded?: boolean
          is_leased?: boolean
          is_starter?: boolean
          retired_at?: string | null
          broken_down_at?: string | null
          hours_at_inspection?: number
          crash_damaged?: boolean
          wear_before_crash?: number | null
          lease_cost?: number
          maintenance_factor?: number
          max_range_nm?: number
          notes?: string | null
          op_cost_hr?: number
          pax_seats?: number
          payload_lbs?: number
          reliability?: number
          sim_title?: string | null
          sim_title_aliases?: string[]
          sling_load?: boolean
          status?: string
          tags?: string[]
          wear?: number
        }
        Relationships: [
          {
            foreignKeyName: "aircraft_base_id_fkey"
            columns: ["base_id"]
            isOneToOne: false
            referencedRelation: "bases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aircraft_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      bases: {
        Row: {
          company_id: string
          created_at: string
          icao: string | null
          latitude: number | null
          longitude: number | null
          nearby_airports: Json
          airports_updated_at: string | null
          placement_sites: Json | null
          sites_scanned_at: string | null
          id: string
          is_primary: boolean
          name: string
          region: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          icao?: string | null
          latitude?: number | null
          longitude?: number | null
          nearby_airports?: Json
          airports_updated_at?: string | null
          placement_sites?: Json | null
          sites_scanned_at?: string | null
          id?: string
          is_primary?: boolean
          name: string
          region?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          icao?: string | null
          latitude?: number | null
          longitude?: number | null
          nearby_airports?: Json
          airports_updated_at?: string | null
          placement_sites?: Json | null
          sites_scanned_at?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          region?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bases_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      industries: {
        Row: {
          id: string
          company_id: string
          base_id: string | null
          kind: string
          name: string | null
          latitude: number
          longitude: number
          confidence: string
          source: string
          stock: number
          input_stock: number
          capacity: number
          base_rate: number
          workers: number
          last_tick_at: string
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          base_id?: string | null
          kind: string
          name?: string | null
          latitude: number
          longitude: number
          confidence?: string
          source?: string
          stock?: number
          input_stock?: number
          capacity: number
          base_rate: number
          workers?: number
          last_tick_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          base_id?: string | null
          kind?: string
          name?: string | null
          latitude?: number
          longitude?: number
          confidence?: string
          source?: string
          stock?: number
          input_stock?: number
          capacity?: number
          base_rate?: number
          workers?: number
          last_tick_at?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "industries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "industries_base_id_fkey"
            columns: ["base_id"]
            isOneToOne: false
            referencedRelation: "bases"
            referencedColumns: ["id"]
          },
        ]
      }
      company_industry_investments: {
        Row: {
          id: string
          company_id: string
          industry_id: string
          invested_total: number
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          industry_id: string
          invested_total?: number
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          industry_id?: string
          invested_total?: number
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_industry_investments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_industry_investments_industry_id_fkey"
            columns: ["industry_id"]
            isOneToOne: false
            referencedRelation: "industries"
            referencedColumns: ["id"]
          },
        ]
      }
      pilot_skills: {
        Row: {
          company_id: string
          user_id: string
          xp: number
          unlocked_perks: string[]
          updated_at: string
        }
        Insert: {
          company_id: string
          user_id: string
          xp?: number
          unlocked_perks?: string[]
          updated_at?: string
        }
        Update: {
          company_id?: string
          user_id?: string
          xp?: number
          unlocked_perks?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pilot_skills_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      industry_defs: {
        Row: {
          kind: string
          chain: string
          tier: number
          output_good: string
          input_good: string | null
          default_capacity: number
          base_rate: number
          capacity_per_dollar: number
          good_unit_lb: number
          good_base_value: number
          build_cost: number
          max_workers: number
          wage_per_hour: number
        }
        Insert: {
          kind: string
          chain: string
          tier: number
          output_good: string
          input_good?: string | null
          default_capacity: number
          base_rate: number
          capacity_per_dollar: number
          good_unit_lb: number
          good_base_value: number
          build_cost?: number
          max_workers?: number
          wage_per_hour?: number
        }
        Update: {
          kind?: string
          chain?: string
          tier?: number
          output_good?: string
          input_good?: string | null
          default_capacity?: number
          base_rate?: number
          capacity_per_dollar?: number
          good_unit_lb?: number
          good_base_value?: number
          build_cost?: number
          max_workers?: number
          wage_per_hour?: number
        }
        Relationships: []
      }
      companies: {
        Row: {
          cash: number
          certifications: string[]
          created_at: string
          difficulty: string
          id: string
          loan_balance: number
          name: string
          realism_mode: string
          reputation: number
          user_id: string
        }
        Insert: {
          cash?: number
          certifications?: string[]
          created_at?: string
          difficulty?: string
          id?: string
          name: string
          loan_balance?: number
          realism_mode?: string
          reputation?: number
          user_id: string
        }
        Update: {
          cash?: number
          certifications?: string[]
          created_at?: string
          difficulty?: string
          id?: string
          name?: string
          loan_balance?: number
          realism_mode?: string
          reputation?: number
          user_id?: string
        }
        Relationships: []
      }
      economy_transactions: {
        Row: {
          aircraft_id: string | null
          amount: number
          company_id: string
          created_at: string
          description: string | null
          id: string
          type: string
        }
        Insert: {
          aircraft_id?: string | null
          amount: number
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          type: string
        }
        Update: {
          aircraft_id?: string | null
          amount?: number
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "economy_transactions_aircraft_id_fkey"
            columns: ["aircraft_id"]
            isOneToOne: false
            referencedRelation: "aircraft"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "economy_transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      fuel_farms: {
        Row: {
          base_id: string
          capacity_lb: number
          company_id: string
          created_at: string
          fuel_lb: number
          fuel_value: number
          id: string
        }
        Insert: {
          base_id: string
          capacity_lb: number
          company_id: string
          created_at?: string
          fuel_lb?: number
          fuel_value?: number
          id?: string
        }
        Update: {
          base_id?: string
          capacity_lb?: number
          company_id?: string
          created_at?: string
          fuel_lb?: number
          fuel_value?: number
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fuel_farms_base_id_fkey"
            columns: ["base_id"]
            isOneToOne: true
            referencedRelation: "bases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_farms_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      industry_deliveries: {
        Row: {
          company_id: string
          created_at: string
          from_industry_id: string | null
          good: string
          mission_id: string
          outcome: string | null
          settled_at: string | null
          to_industry_id: string | null
          units: number
        }
        Insert: {
          company_id: string
          created_at?: string
          from_industry_id?: string | null
          good: string
          mission_id: string
          outcome?: string | null
          settled_at?: string | null
          to_industry_id?: string | null
          units: number
        }
        Update: {
          company_id?: string
          created_at?: string
          from_industry_id?: string | null
          good?: string
          mission_id?: string
          outcome?: string | null
          settled_at?: string | null
          to_industry_id?: string | null
          units?: number
        }
        Relationships: []
      }
      pilot_ratings: {
        Row: {
          company_id: string
          created_at: string
          fee_paid: boolean
          label: string
          passed_at: string | null
          rating: string
          user_id: string
          wing: string
        }
        Insert: {
          company_id: string
          created_at?: string
          fee_paid?: boolean
          label: string
          passed_at?: string | null
          rating: string
          user_id: string
          wing?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          fee_paid?: boolean
          label?: string
          passed_at?: string | null
          rating?: string
          user_id?: string
          wing?: string
        }
        Relationships: []
      }
      aircraft_type_families: {
        Row: {
          internal_id: string
          label: string
          rating: string
          wing: string
        }
        Insert: {
          internal_id: string
          label: string
          rating: string
          wing: string
        }
        Update: {
          internal_id?: string
          label?: string
          rating?: string
          wing?: string
        }
        Relationships: []
      }
      fuel_farm_deliveries: {
        Row: {
          company_id: string
          created_at: string
          fuel_farm_id: string
          fuel_lb: number
          industry_id: string | null
          mission_id: string
          outcome: string | null
          settled_at: string | null
          units: number
        }
        Insert: {
          company_id: string
          created_at?: string
          fuel_farm_id: string
          fuel_lb: number
          industry_id?: string | null
          mission_id: string
          outcome?: string | null
          settled_at?: string | null
          units: number
        }
        Update: {
          company_id?: string
          created_at?: string
          fuel_farm_id?: string
          fuel_lb?: number
          industry_id?: string | null
          mission_id?: string
          outcome?: string | null
          settled_at?: string | null
          units?: number
        }
        Relationships: [
          {
            foreignKeyName: "fuel_farm_deliveries_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: true
            referencedRelation: "missions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_farm_deliveries_fuel_farm_id_fkey"
            columns: ["fuel_farm_id"]
            isOneToOne: false
            referencedRelation: "fuel_farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_farm_deliveries_industry_id_fkey"
            columns: ["industry_id"]
            isOneToOne: false
            referencedRelation: "industries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_farm_deliveries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      flight_logs: {
        Row: {
          aircraft_id: string
          arrival: string | null
          company_id: string
          departure: string | null
          duration_hr: number
          flown_at: string
          source: string
          telemetry: Json | null
          fuel_used: number
          id: string
          incidents: string | null
          landing_quality: string
          mission_id: string | null
          payload: number
          pilot_id: string | null
          success: boolean
          weather_difficulty: number
          score: number | null
          grade: string | null
          score_items: Json
        }
        Insert: {
          aircraft_id: string
          arrival?: string | null
          company_id: string
          departure?: string | null
          duration_hr?: number
          flown_at?: string
          source?: string
          telemetry?: Json | null
          fuel_used?: number
          id?: string
          incidents?: string | null
          landing_quality?: string
          mission_id?: string | null
          payload?: number
          pilot_id?: string | null
          success?: boolean
          weather_difficulty?: number
        }
        Update: {
          aircraft_id?: string
          arrival?: string | null
          company_id?: string
          departure?: string | null
          duration_hr?: number
          flown_at?: string
          source?: string
          telemetry?: Json | null
          fuel_used?: number
          id?: string
          incidents?: string | null
          landing_quality?: string
          mission_id?: string | null
          payload?: number
          pilot_id?: string | null
          success?: boolean
          weather_difficulty?: number
        }
        Relationships: [
          {
            foreignKeyName: "flight_logs_aircraft_id_fkey"
            columns: ["aircraft_id"]
            isOneToOne: false
            referencedRelation: "aircraft"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flight_logs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flight_logs_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "missions"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_events: {
        Row: {
          aircraft_id: string
          company_id: string
          completed_at: string | null
          cost: number
          description: string | null
          id: string
          started_at: string
          status: string
          type: string
          wear_removed: number
        }
        Insert: {
          aircraft_id: string
          company_id: string
          completed_at?: string | null
          cost?: number
          description?: string | null
          id?: string
          started_at?: string
          status?: string
          type: string
          wear_removed?: number
        }
        Update: {
          aircraft_id?: string
          company_id?: string
          completed_at?: string | null
          cost?: number
          description?: string | null
          id?: string
          started_at?: string
          status?: string
          type?: string
          wear_removed?: number
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_events_aircraft_id_fkey"
            columns: ["aircraft_id"]
            isOneToOne: false
            referencedRelation: "aircraft"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      missions: {
        Row: {
          manifest: Json | null
          cargo_lb: number | null
          pickup_name: string | null
          pickup_icao: string | null
          pickup_lat: number | null
          pickup_lon: number | null
          pickup_radius_nm: number | null
          drop_name: string | null
          drop_icao: string | null
          drop_lat: number | null
          drop_lon: number | null
          drop_radius_nm: number | null
          expires_at: string | null
          trip_id: string | null
          delivered_at: string | null
          aircraft_id: string | null
          assigned_pilot_id: string | null
          haul_from_industry_id: string | null
          haul_to_industry_id: string | null
          haul_units: number | null
          company_id: string
          completed_at: string | null
          description: string | null
          destination: string | null
          difficulty: number
          distance_nm: number
          generated_at: string
          dispatched_at: string | null
          objectives_state: Json
          restart_from: string | null
          crash_count: number
          nearest_airport_icao: string | null
          nearest_airport_nm: number | null
          objectives: Json
          scene_name: string | null
          scene_type: string | null
          scene_lon: number | null
          scene_lat: number | null
          id: string
          min_payload: number
          origin: string | null
          payout: number
          required_certs: string[]
          required_tags: string[]
          role: string
          status: string
          title: string
          weather_factor: number
        }
        Insert: {
          manifest?: Json | null
          cargo_lb?: number | null
          pickup_name?: string | null
          pickup_icao?: string | null
          pickup_lat?: number | null
          pickup_lon?: number | null
          pickup_radius_nm?: number | null
          drop_name?: string | null
          drop_icao?: string | null
          drop_lat?: number | null
          drop_lon?: number | null
          drop_radius_nm?: number | null
          expires_at?: string | null
          trip_id?: string | null
          delivered_at?: string | null
          aircraft_id?: string | null
          assigned_pilot_id?: string | null
          haul_from_industry_id?: string | null
          haul_to_industry_id?: string | null
          haul_units?: number | null
          company_id: string
          completed_at?: string | null
          description?: string | null
          destination?: string | null
          difficulty?: number
          distance_nm?: number
          generated_at?: string
          dispatched_at?: string | null
          objectives_state?: Json
          restart_from?: string | null
          crash_count?: number
          nearest_airport_icao?: string | null
          nearest_airport_nm?: number | null
          objectives?: Json
          scene_name?: string | null
          scene_type?: string | null
          scene_lon?: number | null
          scene_lat?: number | null
          id?: string
          min_payload?: number
          origin?: string | null
          payout?: number
          required_certs?: string[]
          required_tags?: string[]
          role: string
          status?: string
          title: string
          weather_factor?: number
        }
        Update: {
          manifest?: Json | null
          cargo_lb?: number | null
          pickup_name?: string | null
          pickup_icao?: string | null
          pickup_lat?: number | null
          pickup_lon?: number | null
          pickup_radius_nm?: number | null
          drop_name?: string | null
          drop_icao?: string | null
          drop_lat?: number | null
          drop_lon?: number | null
          drop_radius_nm?: number | null
          expires_at?: string | null
          trip_id?: string | null
          delivered_at?: string | null
          aircraft_id?: string | null
          assigned_pilot_id?: string | null
          haul_from_industry_id?: string | null
          haul_to_industry_id?: string | null
          haul_units?: number | null
          company_id?: string
          completed_at?: string | null
          description?: string | null
          destination?: string | null
          difficulty?: number
          distance_nm?: number
          generated_at?: string
          dispatched_at?: string | null
          objectives_state?: Json
          restart_from?: string | null
          crash_count?: number
          nearest_airport_icao?: string | null
          nearest_airport_nm?: number | null
          objectives?: Json
          scene_name?: string | null
          scene_type?: string | null
          scene_lon?: number | null
          scene_lat?: number | null
          id?: string
          min_payload?: number
          origin?: string | null
          payout?: number
          required_certs?: string[]
          required_tags?: string[]
          role?: string
          status?: string
          title?: string
          weather_factor?: number
        }
        Relationships: [
          {
            foreignKeyName: "missions_aircraft_id_fkey"
            columns: ["aircraft_id"]
            isOneToOne: false
            referencedRelation: "aircraft"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "missions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          active_company_id: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          active_company_id?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          active_company_id?: string | null
          id?: string
        }
        Relationships: []
      }
      company_members: {
        Row: {
          company_id: string
          user_id: string
          role: string
          callsign: string | null
          joined_at: string
        }
        Insert: {
          company_id: string
          user_id: string
          role?: string
          callsign?: string | null
          joined_at?: string
        }
        Update: {
          company_id?: string
          user_id?: string
          role?: string
          callsign?: string | null
          joined_at?: string
        }
        Relationships: []
      }
      company_invites: {
        Row: {
          id: string
          company_id: string
          code: string
          role: string
          created_by: string
          expires_at: string
          max_uses: number
          uses: number
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          code: string
          role?: string
          created_by: string
          expires_at: string
          max_uses?: number
          uses?: number
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          code?: string
          role?: string
          created_by?: string
          expires_at?: string
          max_uses?: number
          uses?: number
          created_at?: string
        }
        Relationships: []
      }
      cert_catalog: {
        Row: { cert: string; cost: number; min_rep: number }
        Insert: { cert: string; cost: number; min_rep: number }
        Update: { cert?: string; cost?: number; min_rep?: number }
        Relationships: []
      }
      sim_devices: {
        Row: {
          company_id: string
          created_at: string
          id: string
          last_seen_at: string | null
          name: string
          paired_at: string | null
          pairing_code: string | null
          pairing_expires_at: string | null
          revoked_at: string | null
          token_hash: string | null
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          paired_at?: string | null
          pairing_code?: string | null
          pairing_expires_at?: string | null
          revoked_at?: string | null
          token_hash?: string | null
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          paired_at?: string | null
          pairing_code?: string | null
          pairing_expires_at?: string | null
          revoked_at?: string | null
          token_hash?: string | null
          user_id?: string
        }
        Relationships: []
      }
      trips: {
        Row: {
          aircraft_id: string
          cargo_lb: number
          company_id: string
          completed_at: string | null
          created_at: string
          fuel_lb: number | null
          id: string
          loaded_at: string | null
          pax: number
          pickup_icao: string | null
          pickup_lat: number | null
          pickup_lon: number | null
          pickup_name: string | null
          pickup_radius_nm: number
          pilot_id: string | null
          status: string
        }
        Insert: {
          aircraft_id: string
          cargo_lb?: number
          company_id: string
          completed_at?: string | null
          created_at?: string
          fuel_lb?: number | null
          id?: string
          loaded_at?: string | null
          pax?: number
          pickup_icao?: string | null
          pickup_lat?: number | null
          pickup_lon?: number | null
          pickup_name?: string | null
          pickup_radius_nm?: number
          pilot_id?: string | null
          status?: string
        }
        Update: {
          aircraft_id?: string
          cargo_lb?: number
          company_id?: string
          completed_at?: string | null
          created_at?: string
          fuel_lb?: number | null
          id?: string
          loaded_at?: string | null
          pax?: number
          pickup_icao?: string | null
          pickup_lat?: number | null
          pickup_lon?: number | null
          pickup_name?: string | null
          pickup_radius_nm?: number
          pilot_id?: string | null
          status?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      owns_company: { Args: { _company_id: string }; Returns: boolean }
      unlock_pilot_perk: {
        Args: { _company_id: string; _perk: string }
        Returns: Database["public"]["Tables"]["pilot_skills"]["Row"]
      }
      set_industry_workers: {
        Args: { _industry_id: string; _workers: number }
        Returns: Database["public"]["Tables"]["industries"]["Row"]
      }
      ensure_my_rating_rides: {
        Args: { _company_id: string }
        Returns: undefined
      }
      dispatch_mission: {
        Args: { _mission_id: string; _aircraft_id: string }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      cancel_dispatch: {
        Args: { _mission_id: string }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      complete_mission_manual: {
        Args: { _mission_id: string; _aircraft_id: string; _telemetry?: Json }
        Returns: Json
      }
      create_pairing_code: {
        Args: { _name?: string }
        Returns: { code: string; expires_at: string }[]
      }
      revoke_sim_device: { Args: { _device_id: string }; Returns: undefined }
      current_company: {
        Args: Record<string, never>
        Returns: Database["public"]["Tables"]["companies"]["Row"] | null
      }
      my_companies: {
        Args: Record<string, never>
        Returns: {
          id: string
          name: string
          role: string
          cash: number
          reputation: number
          is_active: boolean
        }[]
      }
      company_roster: {
        Args: { _company_id: string }
        Returns: {
          user_id: string
          display_name: string | null
          role: string
          callsign: string | null
          joined_at: string
          flights: number
          hours: number
          avg_score: number | null
        }[]
      }
      company_role: { Args: { _company_id: string }; Returns: string | null }
      is_company_member: { Args: { _company_id: string }; Returns: boolean }
      can_manage_company: { Args: { _company_id: string }; Returns: boolean }
      is_company_owner: { Args: { _company_id: string }; Returns: boolean }
      purchase_certification: {
        Args: { _company_id: string; _cert: string }
        Returns: Json
      }
      purchase_aircraft: {
        Args: { _company_id: string; _spec: Json; _purchase?: boolean }
        Returns: Database["public"]["Tables"]["aircraft"]["Row"]
      }
      service_aircraft: {
        Args: { _aircraft_id: string; _type: string }
        Returns: Json
      }
      log_positioning_flight: {
        Args: { _aircraft_id: string; _telemetry?: Json }
        Returns: Json
      }
      create_invite: {
        Args: { _company_id: string; _role?: string; _max_uses?: number }
        Returns: Database["public"]["Tables"]["company_invites"]["Row"]
      }
      revoke_invite: { Args: { _invite_id: string }; Returns: undefined }
      join_company: { Args: { _code: string }; Returns: Json }
      set_member_role: {
        Args: { _company_id: string; _user_id: string; _role: string }
        Returns: undefined
      }
      remove_member: {
        Args: { _company_id: string; _user_id: string }
        Returns: undefined
      }
      delete_company: {
        Args: { _company_id: string; _confirm_name: string }
        Returns: Json
      }
      dispatch_trip: {
        Args: { _aircraft_id: string; _job_ids: string[]; _fuel_lb?: number }
        Returns: string
      }
      cancel_trip: { Args: { _trip_id: string }; Returns: number }
      set_active_company: { Args: { _company_id: string }; Returns: undefined }
      set_base_sites: { Args: { _base_id: string; _sites: Json }; Returns: string }
      site_industries: {
        Args: { _base_id: string; _sites: Json }
        Returns: Database["public"]["Tables"]["industries"]["Row"][]
      }
      industry_tick: {
        Args: { _industry_id: string }
        Returns: Database["public"]["Tables"]["industries"]["Row"]
      }
      tick_base_industries: {
        Args: { _base_id: string }
        Returns: Database["public"]["Tables"]["industries"]["Row"][]
      }
      invest_in_industry: {
        Args: { _industry_id: string; _amount: number }
        Returns: Database["public"]["Tables"]["industries"]["Row"]
      }
      book_checkride: {
        Args: { _company_id: string; _cert: string; _mission: Json }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      place_industry: {
        Args: { _base_id: string; _kind: string; _lat: number; _lon: number; _name?: string | null }
        Returns: Database["public"]["Tables"]["industries"]["Row"]
      }
      dispatch_trade_run: {
        Args: { _from_industry_id: string; _to_industry_id: string; _quantity: number }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      mission_objectives_met: { Args: { _mission_id: string }; Returns: boolean }
      aircraft_sale_value: { Args: { _aircraft_id: string }; Returns: number }
      aircraft_resale: {
        Args: { _acquisition_cost: number; _hours: number; _wear: number }
        Returns: number
      }
      company_balance_sheet: { Args: { _company_id: string }; Returns: Json }
      take_loan: { Args: { _company_id: string; _amount: number }; Returns: Json }
      repay_loan: { Args: { _company_id: string; _amount: number }; Returns: Json }
      build_fuel_farm: {
        Args: { _base_id: string }
        Returns: Database["public"]["Tables"]["fuel_farms"]["Row"]
      }
      expand_fuel_farm: {
        Args: { _fuel_farm_id: string }
        Returns: Database["public"]["Tables"]["fuel_farms"]["Row"]
      }
      buy_bulk_fuel: { Args: { _fuel_farm_id: string; _lb: number }; Returns: Json }
      dispatch_fuel_run: {
        Args: { _industry_id: string; _fuel_farm_id: string; _units: number }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      sell_aircraft: { Args: { _aircraft_id: string }; Returns: Json }
      return_aircraft: { Args: { _aircraft_id: string }; Returns: Json }
      lease_aircraft: {
        Args: { _company_id: string; _spec: Json }
        Returns: Database["public"]["Tables"]["aircraft"]["Row"]
      }
      lease_rate_for: { Args: { _acquisition_cost: number }; Returns: number }
      lease_deposit_for: { Args: { _acquisition_cost: number }; Returns: number }
      create_company: {
        Args: {
          _name: string
          _difficulty?: string
          _realism?: string
          _base_name?: string
          _icao?: string | null
          _starter?: Json
        }
        Returns: Database["public"]["Tables"]["companies"]["Row"]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
