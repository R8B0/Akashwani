import * as THREE from "three";
import { LineMaterial } from "jsm/lines/LineMaterial.js";
import { LineGeometry } from "jsm/lines/LineGeometry.js";
import { Line2 } from "jsm/lines/Line2.js";

export function drawThreeGeo({ json, radius, materialOptions }) {
  const container = new THREE.Object3D();
  container.userData.update = (t) => {
    for (let i = 0; i < container.children.length; i++) {
      container.children[i].userData.update?.(t);
    }
  }

  container.rotation.x = -Math.PI * 0.5;
  const x_values = [];
  const y_values = [];
  const z_values = [];
  const json_geom = createGeometryArray(json);

  let coordinate_array = [];
  for (let geom_num = 0; geom_num < json_geom.length; geom_num++) {
    if (json_geom[geom_num].type == 'Point') {
      convertToSphereCoords(json_geom[geom_num].coordinates, radius);
      drawParticle(x_values[0], y_values[0], z_values[0], materialOptions);

    } else if (json_geom[geom_num].type == 'MultiPoint') {
      for (let point_num = 0; point_num < json_geom[geom_num].coordinates.length; point_num++) {
        convertToSphereCoords(json_geom[geom_num].coordinates[point_num], radius);
        drawParticle(x_values[0], y_values[0], z_values[0], materialOptions);
      }

    } else if (json_geom[geom_num].type == 'LineString') {
      coordinate_array = createCoordinateArray(json_geom[geom_num].coordinates);

      for (let point_num = 0; point_num < coordinate_array.length; point_num++) {
        convertToSphereCoords(coordinate_array[point_num], radius);
      }
      drawLine(x_values, y_values, z_values, materialOptions);

    } else if (json_geom[geom_num].type == 'Polygon') {
      for (let segment_num = 0; segment_num < json_geom[geom_num].coordinates.length; segment_num++) {
        coordinate_array = createCoordinateArray(json_geom[geom_num].coordinates[segment_num]);

        for (let point_num = 0; point_num < coordinate_array.length; point_num++) {
          convertToSphereCoords(coordinate_array[point_num], radius);
        }
        drawLine(x_values, y_values, z_values, materialOptions);
      }

    } else if (json_geom[geom_num].type == 'MultiLineString') {
      for (let segment_num = 0; segment_num < json_geom[geom_num].coordinates.length; segment_num++) {
        coordinate_array = createCoordinateArray(json_geom[geom_num].coordinates[segment_num]);

        for (let point_num = 0; point_num < coordinate_array.length; point_num++) {
          convertToSphereCoords(coordinate_array[point_num], radius);
        }
        drawLine(x_values, y_values, z_values, materialOptions);
      }

    } else if (json_geom[geom_num].type == 'MultiPolygon') {
      for (let polygon_num = 0; polygon_num < json_geom[geom_num].coordinates.length; polygon_num++) {
        for (let segment_num = 0; segment_num < json_geom[geom_num].coordinates[polygon_num].length; segment_num++) {
          coordinate_array = createCoordinateArray(json_geom[geom_num].coordinates[polygon_num][segment_num]);

          for (let point_num = 0; point_num < coordinate_array.length; point_num++) {
            convertToSphereCoords(coordinate_array[point_num], radius);
          }
          drawLine(x_values, y_values, z_values, materialOptions);
        }
      }
    } else {
      throw new Error('The geoJSON is not valid.');
    }
  }

  function createGeometryArray(json) {
    let geometry_array = [];

    if (json.type == 'Feature') {
      geometry_array.push(json.geometry);
    } else if (json.type == 'FeatureCollection') {
      for (let feature_num = 0; feature_num < json.features.length; feature_num++) {
        geometry_array.push(json.features[feature_num].geometry);
      }
    } else if (json.type == 'GeometryCollection') {
      for (let geom_num = 0; geom_num < json.geometries.length; geom_num++) {
        geometry_array.push(json.geometries[geom_num]);
      }
    } else {
      throw new Error('The geoJSON is not valid.');
    }
    return geometry_array;
  }

  function createCoordinateArray(feature) {
    const temp_array = [];
    let interpolation_array = [];

    for (let point_num = 0; point_num < feature.length; point_num++) {
      const point1 = feature[point_num];
      const point2 = feature[point_num - 1];

      if (point_num > 0) {
        if (needsInterpolation(point2, point1)) {
          interpolation_array = [point2, point1];
          interpolation_array = interpolatePoints(interpolation_array);

          for (let inter_point_num = 0; inter_point_num < interpolation_array.length; inter_point_num++) {
            temp_array.push(interpolation_array[inter_point_num]);
          }
        } else {
          temp_array.push(point1);
        }
      } else {
        temp_array.push(point1);
      }
    }
    return temp_array;
  }

  function needsInterpolation(point2, point1) {
    const lon1 = point1[0];
    const lat1 = point1[1];
    const lon2 = point2[0];
    const lat2 = point2[1];
    const lon_distance = Math.abs(lon1 - lon2);
    const lat_distance = Math.abs(lat1 - lat2);

    if (lon_distance > 5 || lat_distance > 5) {
      return true;
    } else {
      return false;
    }
  }

  function interpolatePoints(interpolation_array) {
    let temp_array = [];
    let point1, point2;

    for (let point_num = 0; point_num < interpolation_array.length - 1; point_num++) {
      point1 = interpolation_array[point_num];
      point2 = interpolation_array[point_num + 1];

      if (needsInterpolation(point2, point1)) {
        temp_array.push(point1);
        temp_array.push(getMidpoint(point1, point2));
      } else {
        temp_array.push(point1);
      }
    }

    temp_array.push(interpolation_array[interpolation_array.length - 1]);

    if (temp_array.length > interpolation_array.length) {
      temp_array = interpolatePoints(temp_array);
    } else {
      return temp_array;
    }
    return temp_array;
  }

  function getMidpoint(point1, point2) {
    const midpoint_lon = (point1[0] + point2[0]) / 2;
    const midpoint_lat = (point1[1] + point2[1]) / 2;
    const midpoint = [midpoint_lon, midpoint_lat];

    return midpoint;
  }

  function convertToSphereCoords(coordinates_array, sphere_radius) {
    const lon = coordinates_array[0];
    const lat = coordinates_array[1];

    x_values.push(Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180) * sphere_radius);
    y_values.push(Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180) * sphere_radius);
    z_values.push(Math.sin(lat * Math.PI / 180) * sphere_radius);
  }

  function drawParticle(x, y, z, options) {
    let geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([x, y, z], 3)
    );

    const particle_material = new THREE.PointsMaterial(options || { size: 0.01, color: 0xffffff });

    const particle = new THREE.Points(geo, particle_material);
    container.add(particle);

    clearArrays();
  }

  function drawLine(x_values, y_values, z_values, options) {
    const lineGeo = new LineGeometry();
    const verts = [];
    for (let i = 0; i < x_values.length; i++) {
      verts.push(x_values[i], y_values[i], z_values[i]);
    }
    lineGeo.setPositions(verts);
    if (options && (options.color || options.linewidth || options.opacity)) {
      // Use provided options but bump the default linewidth to make borders more visible
      const color = options.color !== undefined ? options.color : 0xffffff;
      const opacity = options.opacity !== undefined ? options.opacity : 1.0;
      const lineMaterial = new LineMaterial({
        color: new THREE.Color(color),
        linewidth: options.linewidth || 3,
        transparent: opacity < 1.0,
        opacity,
        fog: true
      });

      const line = new Line2(lineGeo, lineMaterial);
      line.computeLineDistances();
      container.add(line);
    } else {
      // Brighter, thicker default border so country outlines stand out against the globe
      const color = new THREE.Color(0xffffff); // white borders
      const lineMaterial = new LineMaterial({
        color,
        linewidth: 3,
        transparent: false,
        opacity: 1.0,
        fog: true
      });

      const line = new Line2(lineGeo, lineMaterial);
      line.computeLineDistances();
      // keep a minimal subtle animation if desired (rate very small)
      const rate = Math.random() * 0.00005;
      line.userData.update = (t) => {
        // only used if dash features are enabled elsewhere; harmless otherwise
        lineMaterial.dashOffset = t * rate;
      }
      container.add(line);
    }

    clearArrays();
  }

  function clearArrays() {
    x_values.length = 0;
    y_values.length = 0;
    z_values.length = 0;
  }

  return container;
}
