import { ZarrArray, TypedArray } from 'zarr';
import { RawArray } from 'zarr/dist/types/rawArray';
import {
  Dimension,
  ImageLoader,
  VivMetadata,
  TileIndex,
  RasterIndex,
  DimensionSelection,
} from './types';
import { guessRgb, normalizeChannelSelection } from './utils';

export default class ZarrLoader implements ImageLoader {
  public type: string;
  public isRgb: boolean;
  public scale: number;
  public translate: number[];
  public dimensions?: Dimension[];

  private _xIndex: number;
  private _yIndex: number;
  private _data: ZarrArray | ZarrArray[];
  private _channelSelections: number[][];

  constructor(
    data: ZarrArray | ZarrArray[],
    dimensions?: Dimension[],
    isRgb?: boolean,
    scale = 1,
    translate = [0, 0],
  ) {
    let base;
    if (Array.isArray(data)) {
      [base] = data;
    } else {
      base = data;
    }
    // Public attributes
    this.type = 'zarr';
    this.scale = scale;
    this.translate = translate;
    this.dimensions = dimensions;
    this.isRgb = isRgb ? isRgb : guessRgb(base.shape);

    // Private attributes
    this._data = data;
    if (isRgb) {
      this._xIndex = base.shape.length - 2;
      this._yIndex = base.shape.length - 3;
    } else {
      this._xIndex = base.shape.length - 1;
      this._yIndex = base.shape.length - 2;
    }
    this._channelSelections = [Array(base.shape.length).fill(0)];
  }

  public get isPyramid(): boolean {
    return Array.isArray(this._data);
  }

  public get base(): ZarrArray {
    return this.isPyramid ? (this._data as ZarrArray[])[0] : (this._data as ZarrArray);
  }

  public get vivMetadata(): VivMetadata {
    const base = this.base;
    const { dtype } = base;
    const imageHeight = base.shape[this._yIndex];
    const imageWidth = base.shape[this._xIndex];
    const tileSize = base.chunks[this._xIndex];
    const minZoom = this.isPyramid ? -this._data.length : 0;
    return {
      imageWidth,
      imageHeight,
      tileSize,
      minZoom,
      dtype,
      scale: this.scale,
      translate: this.translate,
    };
  }

  public async getTile({ x, y, z }: TileIndex): Promise<TypedArray[]> {
    const source = this._getSource(z);
    const dataRequests = this._channelSelections.map(async chunkKey => {
      chunkKey[this._yIndex] = y;
      chunkKey[this._xIndex] = x;
      const { data } = await source.getRawChunk(chunkKey);
      return data;
    });
    const data = await Promise.all(dataRequests);
    return data;
  }

  public async getRaster({ z }: RasterIndex): Promise<TypedArray[]> {
    const source = this._getSource(z);
    const dataRequests = this._channelSelections.map(async (chunkKey: (number | null)[]) => {
      chunkKey[this._yIndex] = null;
      chunkKey[this._xIndex] = null;
      const { data } = (await source.getRaw(chunkKey)) as RawArray;
      return data;
    });
    const data = await Promise.all(dataRequests);
    return data;
  }

  public setChannelSelections(
    channelSelections: (DimensionSelection | number)[][] | (DimensionSelection | number)[],
  ): void {
    // Wrap channel selection in array if only one is provided
    channelSelections = (Array.isArray(channelSelections[0])
      ? channelSelections
      : [channelSelections]) as (DimensionSelection | number)[][];
    const nextChannelSelections: number[][] = channelSelections.map(sel => {
      if (sel.length === this.base.shape.length && sel.every(d => typeof d === 'number')) {
        // e.g. sel === [4, 5, 0, 0]
        return sel as number[];
      } else if (this.dimensions) {
        // e.g.
        // sel === [{id: 'time', index: 3}, {id: 'stain', index: 'DAPI'}]
        // sel === [{id: 0, index: 1, {id: 2, index: 50}]
        return normalizeChannelSelection(this.dimensions, sel as DimensionSelection[]);
      } else {
        throw Error(
          `Cannot set selection using '${sel}' for image with unlabeled dimensions.
          Consider specifying labels or indexing image directly.`,
        );
      }
    });
    if (this.isRgb && nextChannelSelections.length > 1) {
      throw Error('Cannot specify multiple channel selections for RGB/A image.');
    }
    this._channelSelections = nextChannelSelections;
  }

  private _getSource(z?: number): ZarrArray {
    return z && this.isPyramid ? (this._data as ZarrArray[])[z] : (this._data as ZarrArray);
  }
}
