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
          retired_at: string | null
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
          retired_at?: string | null
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
          retired_at?: string | null
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
          stock: number
          capacity: number
          base_rate: number
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
          stock?: number
          capacity: number
          base_rate: number
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
          stock?: number
          capacity?: number
          base_rate?: number
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
          realism_mode?: string
          reputation?: number
          user_id?: string
        }
        Relationships: []
      }
      economy_transactions: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          description: string | null
          id: string
          type: string
        }
        Insert: {
          amount: number
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          type: string
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "economy_transactions_company_id_fkey"
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
          aircraft_id: string | null
          assigned_pilot_id: string | null
          company_id: string
          completed_at: string | null
          description: string | null
          destination: string | null
          difficulty: number
          distance_nm: number
          generated_at: string
          dispatched_at: string | null
          objectives_state: Json
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
          aircraft_id?: string | null
          assigned_pilot_id?: string | null
          company_id: string
          completed_at?: string | null
          description?: string | null
          destination?: string | null
          difficulty?: number
          distance_nm?: number
          generated_at?: string
          dispatched_at?: string | null
          objectives_state?: Json
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
          aircraft_id?: string | null
          assigned_pilot_id?: string | null
          company_id?: string
          completed_at?: string | null
          description?: string | null
          destination?: string | null
          difficulty?: number
          distance_nm?: number
          generated_at?: string
          dispatched_at?: string | null
          objectives_state?: Json
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      owns_company: { Args: { _company_id: string }; Returns: boolean }
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
      dispatch_trade_run: {
        Args: { _from_industry_id: string; _to_industry_id: string; _quantity: number }
        Returns: Database["public"]["Tables"]["missions"]["Row"]
      }
      mission_objectives_met: { Args: { _mission_id: string }; Returns: boolean }
      aircraft_sale_value: { Args: { _aircraft_id: string }; Returns: number }
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
