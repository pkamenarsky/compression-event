declare module 'simplepolygon' {
  import { Feature, Polygon, FeatureCollection } from '@turf/helpers';
  export default function simplepolygon(polygon: Feature<Polygon>): FeatureCollection<Polygon>;
}
