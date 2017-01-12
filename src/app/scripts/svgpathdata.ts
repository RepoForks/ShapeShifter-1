import * as _ from 'lodash';
import { Bezier, Projection } from './bezierutil';
import { Point, Matrix, Rect } from './mathutil';
import * as MathUtil from './mathutil';
import {
  DrawCommand, MoveCommand, LineCommand, QuadraticCurveCommand,
  BezierCurveCommand, EllipticalArcCommand, ClosePathCommand, SubPathCommand
} from './svgcommands';
import { IPathCommand } from './commands';
import * as SvgUtil from './svgutil';
import * as PathParser from './pathparser';

/**
 * Provides all of the information associated with a vector drawable's path data.
 */
export class SvgPathData implements IPathCommand {
  private originalDrawCommands_: DrawCommand[];
  private drawCommandWrappers_: DrawCommandWrapper[];
  private commands_: SubPathCommand[] = [];
  private path_: string;
  private length_ = 0;
  private bounds_: Rect = null;

  // TODO(alockwood): need to dynamically update the length/bounds/pathstring
  constructor(path: string) {
    this.path_ = path;
    this.originalDrawCommands_ = PathParser.parseCommands(this.path_);

    const {length, bounds, drawCommandWrappers} =
      initInternalState(this, this.originalDrawCommands_);
    this.length_ = length;
    this.bounds_ = bounds;
    this.drawCommandWrappers_ = drawCommandWrappers;

    this.rebuildInternalState();
  }

  get id() {
    return this.path_;
  }

  get commands() {
    return this.commands_;
  }

  /** Returns the path length of this SVG path. */
  get length() {
    return this.length_;
  }

  toString() {
    return this.path_;
  }

  // TODO(alockwood): make this private
  rebuildInternalState(rebuildPathString = false) {
    const drawCommands = [].concat.apply([], this.drawCommandWrappers_.map(cw => cw.commands));
    if (rebuildPathString) {
      this.path_ = PathParser.commandsToString(drawCommands);
    }
    this.commands_ = createSubPathCommands(drawCommands);
  }

  /** Returns true iff this path is morphable with the specified path. */
  isMorphableWith(cmd: SvgPathData) {
    return this.commands.length === cmd.commands.length
      && this.commands.every((s, i) => {
        return s.commands.length === cmd.commands[i].commands.length
          && s.commands.every((d, j) => {
            const drawCmd = cmd.commands[i].commands[j];
            return d.constructor === drawCmd.constructor
              && d.points.length === drawCmd.points.length;
          });
      });
  }

  /** Interpolates this path between a start and end path using the specified fraction. */
  interpolate(start: SvgPathData, end: SvgPathData, fraction: number) {
    if (!this.isMorphableWith(start) || !this.isMorphableWith(end)) {
      return;
    }
    this.commands.forEach((s, i) => {
      s.commands.forEach((d, j) => {
        if (d instanceof EllipticalArcCommand) {
          // TODO(alockwood): confirm this is how we should interpolate arcs?
          const d1 = start.commands[i].commands[j] as EllipticalArcCommand;
          const d2 = end.commands[i].commands[j] as EllipticalArcCommand;
          d.args.forEach((_, i) => {
            if (i === 5 || i === 6) {
              // Doesn't make sense to interpolate the large arc and sweep flags.
              d.args[i] = fraction === 0 ? d1.args[i] : d2.args[i];
              return;
            }
            d.args[i] = MathUtil.lerp(d1.args[i], d2.args[i], fraction);
          });
        } else {
          const d1 = start.commands[i].commands[j];
          const d2 = end.commands[i].commands[j];
          for (let i = 0; i < d1.points.length; i++) {
            const startPoint = d1.points[i];
            const endPoint = d2.points[i];
            if (startPoint && endPoint) {
              const x = MathUtil.lerp(startPoint.x, endPoint.x, fraction);
              const y = MathUtil.lerp(startPoint.y, endPoint.y, fraction);
              d.points[i] = new Point(x, y);
            }
          }
        }
      });
    });
    this.rebuildInternalState();
  }

  /** Draws the SVG path on the provided canvas context. */
  execute(ctx: CanvasRenderingContext2D) {
    ctx.beginPath();
    this.commands.forEach(s => s.commands.forEach(d => {
      if (d instanceof MoveCommand) {
        ctx.moveTo(d.end.x, d.end.y);
      } else if (d instanceof LineCommand) {
        ctx.lineTo(d.end.x, d.end.y);
      } else if (d instanceof QuadraticCurveCommand) {
        ctx.quadraticCurveTo(
          d.points[1].x, d.points[1].y,
          d.points[2].x, d.points[2].y);
      } else if (d instanceof BezierCurveCommand) {
        ctx.bezierCurveTo(
          d.points[1].x, d.points[1].y,
          d.points[2].x, d.points[2].y,
          d.points[3].x, d.points[3].y);
      } else if (d instanceof ClosePathCommand) {
        ctx.closePath();
      } else if (d instanceof EllipticalArcCommand) {
        SvgUtil.executeArc(ctx, d.args);
      }
    }));
  }

  /**
   * Calculates the point on this path that is closest to the specified point argument.
   * Also returns a 'split' function that can be used to split the path at the returned
   * projection point.
   */
  project(point: Point): ProjectionInfo | null {
    return this.drawCommandWrappers_.map(cw => {
      const projection = cw.project(point);
      return {
        projection,
        split: () => {
          cw.split(projection.t);
          this.rebuildInternalState(true);
        }
      };
    }).filter(item => !!item.projection)
      .reduce((prev, curr) => {
        return prev && prev.projection.d < curr.projection.d ? prev : curr;
      }, null);
  }
}


function createSubPathCommands(drawCommands: DrawCommand[]) {
  if (!drawCommands.length) {
    return [];
  }
  const cmdGroups: DrawCommand[][] = [];
  let currentCmdList = [];
  for (let i = drawCommands.length - 1; i >= 0; i--) {
    const cmd = drawCommands[i];
    currentCmdList.push(cmd);
    if (cmd instanceof MoveCommand) {
      cmdGroups.push(currentCmdList);
      currentCmdList = [];
    }
  }
  return cmdGroups.reverse().map(cmds => new SubPathCommand(...cmds.reverse()));
}


function initInternalState(svgPathData: SvgPathData, commands: DrawCommand[]) {
  let length = 0;
  const bounds = new Rect(Infinity, Infinity, -Infinity, -Infinity);

  const expandBounds_ = (x: number, y: number) => {
    bounds.l = Math.min(x, bounds.l);
    bounds.t = Math.min(y, bounds.t);
    bounds.r = Math.max(x, bounds.r);
    bounds.b = Math.max(y, bounds.b);
  };

  const expandBoundsToBezier_ = (bez: Bezier) => {
    const bbox = bez.bbox();
    expandBounds_(bbox.x.min, bbox.y.min);
    expandBounds_(bbox.x.max, bbox.y.min);
    expandBounds_(bbox.x.min, bbox.y.max);
    expandBounds_(bbox.x.max, bbox.y.max);
  };

  let firstPoint = null;
  let currentPoint = new Point(0, 0);

  const drawCommandWrappers: DrawCommandWrapper[] = [];
  commands.forEach(cmd => {
    if (cmd instanceof MoveCommand) {
      const nextPoint = cmd.points[1];
      if (!firstPoint) {
        firstPoint = nextPoint;
      }
      currentPoint = nextPoint;
      expandBounds_(nextPoint.x, nextPoint.y);
      drawCommandWrappers.push(new DrawCommandWrapper(svgPathData, cmd));
    } else if (cmd instanceof LineCommand) {
      const nextPoint = cmd.points[1];
      length += MathUtil.distance(currentPoint, nextPoint);
      drawCommandWrappers.push(new DrawCommandWrapper(svgPathData,
        cmd, new Bezier(currentPoint, currentPoint, nextPoint, nextPoint)));
      currentPoint = nextPoint;
      expandBounds_(nextPoint.x, nextPoint.y);
    } else if (cmd instanceof ClosePathCommand) {
      if (firstPoint) {
        length += MathUtil.distance(firstPoint, currentPoint);
        drawCommandWrappers.push(new DrawCommandWrapper(svgPathData,
          cmd, new Bezier(currentPoint, currentPoint, firstPoint, firstPoint)));
      }
      firstPoint = null;
    } else if (cmd instanceof BezierCurveCommand) {
      const points = cmd.points;
      const bez = new Bezier(currentPoint, points[1], points[2], points[3]);
      drawCommandWrappers.push(new DrawCommandWrapper(svgPathData, cmd, bez));
      length += bez.length();
      currentPoint = points[3];
      expandBoundsToBezier_(bez);
    } else if (cmd instanceof QuadraticCurveCommand) {
      const points = cmd.points;
      const bez = new Bezier(currentPoint, points[1], points[2]);
      drawCommandWrappers.push(new DrawCommandWrapper(svgPathData, cmd, bez));
      length += bez.length();
      currentPoint = points[2];
      expandBoundsToBezier_(bez);
    } else if (cmd instanceof EllipticalArcCommand) {
      const args = cmd.args;
      const [currentPointX, currentPointY,
        rx, ry, xAxisRotation,
        largeArcFlag, sweepFlag,
        tempPoint1X, tempPoint1Y] = args;

      if (currentPointX === tempPoint1X && currentPointY === tempPoint1Y) {
        // degenerate to point (0 length)
        drawCommandWrappers.push(new DrawCommandWrapper(svgPathData, cmd));
        return;
      }

      if (rx === 0 || ry === 0) {
        // degenerate to line
        const nextPoint = new Point;
        length += MathUtil.distance(
          { x: currentPointX, y: currentPointY },
          { x: tempPoint1X, y: tempPoint1Y });
        expandBounds_(tempPoint1X, tempPoint1Y);
        drawCommandWrappers.push(new DrawCommandWrapper(svgPathData,
          cmd, new Bezier(currentPoint, currentPoint, nextPoint, nextPoint)));
        currentPoint = nextPoint;
        return;
      }

      const bezierCoords = SvgUtil.arcToBeziers(
        currentPointX, currentPointY,
        rx, ry, xAxisRotation,
        largeArcFlag, sweepFlag,
        tempPoint1X, tempPoint1Y);

      const arcBeziers: Bezier[] = [];
      for (let i = 0; i < bezierCoords.length; i += 8) {
        const bez = new Bezier(
          { x: currentPoint.x, y: currentPoint.y },
          { x: bezierCoords[i + 2], y: bezierCoords[i + 3] },
          { x: bezierCoords[i + 4], y: bezierCoords[i + 5] },
          { x: bezierCoords[i + 6], y: bezierCoords[i + 7] });
        arcBeziers.push(bez);
        length += bez.length();
        currentPoint = new Point(bezierCoords[i + 6], bezierCoords[i + 7]);
        expandBoundsToBezier_(bez);
      }
      drawCommandWrappers.push(new DrawCommandWrapper(svgPathData, cmd, ...arcBeziers));
      currentPoint = new Point(tempPoint1X, tempPoint1Y);
    }
  });

  return { length, bounds, drawCommandWrappers };
}


/**
 * Contains additional information about each individual draw command.
 */
class DrawCommandWrapper {
  // TODO(alockwood): possible to have more than one bezier for elliptical arcs
  private readonly sourceBeziers: Bezier[];
  private readonly splits: number[] = [];
  private splitCommands: DrawCommand[] = [];

  constructor(
    private readonly svgPathData: SvgPathData,
    public readonly sourceCommand: DrawCommand,
    ...sourceBeziers: Bezier[]) {
    this.sourceBeziers = sourceBeziers;
  }

  project(point: Point): Projection | null {
    return this.sourceBeziers
      .map(bez => bez.project(point))
      .reduce((prev, curr) => prev && prev.d < curr.d ? prev : curr, null);
  }

  split(t: number) {
    if (!this.sourceBeziers.length) {
      return;
    }
    if (this.sourceCommand instanceof EllipticalArcCommand) {
      throw new Error('TODO: implement split support for elliptical arcs');
    }
    this.splits.splice(_.sortedIndex(this.splits, t), 0, t);
    this.rebuildSplitCommands();
  }

  private rebuildSplitCommands() {
    this.splitCommands = [];
    if (!this.splits.length) {
      return;
    }
    const splits = [...this.splits, 1];
    let prevT = 0;
    for (let currT of splits) {
      // TODO(alockwood): possible to have more than one bezier for elliptical arcs
      const bez = this.sourceBeziers[0].split(prevT, currT);
      this.splitCommands.push(this.bezierToDrawCommand(bez));
      prevT = currT;
    }
  }

  private bezierToDrawCommand(bezier: Bezier) {
    const cmd = this.sourceCommand;
    if (cmd instanceof LineCommand) {
      return new LineCommand(bezier.start, bezier.end);
    } else if (cmd instanceof ClosePathCommand) {
      return new ClosePathCommand(bezier.start, bezier.end);
    } else if (cmd instanceof QuadraticCurveCommand) {
      return new QuadraticCurveCommand(bezier.start, bezier.cp1, bezier.end);
    } else if (cmd instanceof BezierCurveCommand) {
      return new BezierCurveCommand(bezier.start, bezier.cp1, bezier.cp2, bezier.end);
    } else {// if (cmd instanceof EllipticalArcCommand) {
      throw new Error('TODO: implement split for ellpitical arcs');
    }
  }

  get commands() {
    if (this.splitCommands.length) {
      for (let i = 0; i < this.splitCommands.length - 1; i++) {
        const cmd = this.splitCommands[i];
        cmd.onDeleteCommandClick = () => {
          this.splits.splice(i, 1);
          this.rebuildSplitCommands();
          this.svgPathData.rebuildInternalState();
        };
      }
      return this.splitCommands;
    }
    return [this.sourceCommand];
  }
}

export type ProjectionInfo = {
  projection: Projection;
  split: () => void;
};

